import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { branchMenu, flowSuite, reload, remoteMenu, run, tagMenu } from './flow-helpers.ts';
import { git, waitFor, workspaceRoot } from './helpers.ts';

const IDENTITY = ['-c', 'user.name=Other Person', '-c', 'user.email=other@example.com'];

describe('remote operations', () => {
  const { api, panel, ui } = flowSuite();
  let root: string;
  let bare: string;
  const remote = (...args: string[]) => execFileSync('git', args, { cwd: bare, encoding: 'utf8' }).trim();
  const errors = () => ui.of('notify').filter((n) => n.level === 'error');
  const commit = (file: string, content: string, subject: string) => {
    writeFileSync(join(workspaceRoot(), file), content);
    git('add', file);
    git('commit', '--quiet', '-m', subject);
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'strata-remote-'));
    bare = join(root, 'origin.git');
    execFileSync('git', ['init', '--quiet', '--bare', bare]);
    git('remote', 'add', 'origin', bare);
    git('branch', 'strata-pub', 'main~1');
    await reload(panel());
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const publish = async () => {
    await run('strata.publish', branchMenu('strata-pub', git('rev-parse', 'strata-pub')));
    assert.equal(git('rev-parse', '--abbrev-ref', 'strata-pub@{upstream}'), 'origin/strata-pub');
    await reload(panel());
  };

  it('publishes a branch to the only remote and makes it the upstream', async () => {
    await publish();
    assert.equal(remote('rev-parse', 'strata-pub'), git('rev-parse', 'strata-pub'));
    assert.equal(ui.of('pick').length, 0, 'one remote: nothing to choose');
  });

  it('fetches what others pushed before saying what a force push would overwrite, and leases on it', async () => {
    await publish();
    const other = join(root, 'other');
    execFileSync('git', ['clone', '--quiet', '--branch', 'strata-pub', bare, other]);
    writeFileSync(join(other, 'theirs.txt'), 'theirs\n');
    execFileSync('git', [...IDENTITY, '-C', other, 'add', '.']);
    execFileSync('git', [...IDENTITY, '-C', other, 'commit', '--quiet', '-m', 'Their fix']);
    execFileSync('git', ['-C', other, 'push', '--quiet', 'origin', 'strata-pub']);
    const mine = git('commit-tree', 'strata-pub^{tree}', '-p', 'strata-pub', '-m', 'Mine');
    git('update-ref', 'refs/heads/strata-pub', mine);
    await reload(panel());

    const config = vscode.workspace.getConfiguration('git');
    await config.update('allowForcePush', true, vscode.ConfigurationTarget.Global);
    try {
      ui.press('Force Push (With Lease)...', 'Force Push');
      await run('strata.push', { ...branchMenu('strata-pub', mine), strataUpstream: true });
      const asked = ui.of('confirm');
      assert.equal(asked.length, 2);
      assert.equal(asked[0]!.message, "'origin/strata-pub' has 1 commit that 'strata-pub' doesn't have.");
      assert.deepEqual(asked[0]!.buttons, ['Force Push (With Lease)...'], 'not the current branch: no Pull');
      assert.match(asked[1]!.detail, /\(newest "Their fix"\)/);
      assert.equal(remote('rev-parse', 'strata-pub'), mine);
    } finally {
      await config.update('allowForcePush', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  /** strata-pub published, then a commit of someone else pushed and one of mine made: they diverged. */
  const diverged = async () => {
    await publish();
    const other = join(root, 'other');
    execFileSync('git', ['clone', '--quiet', '--branch', 'strata-pub', bare, other]);
    writeFileSync(join(other, 'theirs.txt'), 'theirs\n');
    execFileSync('git', [...IDENTITY, '-C', other, 'add', '.']);
    execFileSync('git', [...IDENTITY, '-C', other, 'commit', '--quiet', '-m', 'Their fix']);
    execFileSync('git', ['-C', other, 'push', '--quiet', 'origin', 'strata-pub']);
    const mine = git('commit-tree', 'strata-pub^{tree}', '-p', 'strata-pub', '-m', 'Mine');
    git('update-ref', 'refs/heads/strata-pub', mine);
    await reload(panel());
    return mine;
  };

  it('says how to get past a rejected push of another branch when it has nothing to offer', async () => {
    const mine = await diverged();
    await run('strata.push', { ...branchMenu('strata-pub', mine), strataUpstream: true });
    assert.deepEqual(ui.of('confirm'), []);
    assert.deepEqual(
      errors().map((e) => [e.message, e.actions]),
      [
        [
          "'origin/strata-pub' has 1 commit that 'strata-pub' doesn't have. Switch to 'strata-pub' and pull it first.",
          ['Show Output'],
        ],
      ],
    );
  });

  it('offers to push again after the Pull a rejected push offered', async () => {
    const mine = await diverged();
    git('switch', '--quiet', 'strata-pub');
    git('config', 'pull.rebase', 'true');
    await reload(panel());
    ui.press('Pull').click('Push');
    await run('strata.push', { ...branchMenu('strata-pub', mine), strataUpstream: true });
    assert.equal(ui.first('confirm').detail, "Pull brings it into 'strata-pub', then you can push.");
    const done = ui.of('notify').find((n) => n.actions.includes('Push'));
    assert.deepEqual(done?.actions, ['Undo', 'Push']);
    await waitFor('pushed after the pull', () => remote('rev-parse', 'strata-pub') === git('rev-parse', 'strata-pub'));
    assert.equal(git('log', '-1', '--format=%s', 'strata-pub'), 'Mine');
  });

  it('refuses the force push when the remote moved after the confirmation read it', async () => {
    await publish();
    const other = join(root, 'other');
    execFileSync('git', ['clone', '--quiet', '--branch', 'strata-pub', bare, other]);
    const theirs = (subject: string) => {
      writeFileSync(join(other, 'theirs.txt'), `${subject}\n`);
      execFileSync('git', [...IDENTITY, '-C', other, 'add', '.']);
      execFileSync('git', [...IDENTITY, '-C', other, 'commit', '--quiet', '-m', subject]);
      execFileSync('git', ['-C', other, 'push', '--quiet', 'origin', 'strata-pub']);
      return execFileSync('git', ['-C', other, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    };
    theirs('Their fix');
    const mine = git('commit-tree', 'strata-pub^{tree}', '-p', 'strata-pub', '-m', 'Mine');
    git('update-ref', 'refs/heads/strata-pub', mine);
    await reload(panel());

    const config = vscode.workspace.getConfiguration('git');
    await config.update('allowForcePush', true, vscode.ConfigurationTarget.Global);
    try {
      let newest = '';
      ui.press('Force Push (With Lease)...', 'Force Push').meanwhile(() => {
        newest = theirs('Their second fix');
      });
      await run('strata.push', { ...branchMenu('strata-pub', mine), strataUpstream: true });
      assert.match(ui.of('confirm')[1]?.detail ?? '', /\(newest "Their fix"\)/);
      assert.match(errors()[0]?.message ?? '', /\[rejected\].*\(stale info\)/);
      assert.equal(remote('rev-parse', 'strata-pub'), newest);
    } finally {
      await config.update('allowForcePush', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it('asks before pushing to an upstream of another name, offering a branch of its own first', async () => {
    await publish();
    git('branch', '--track', 'strata-fix', 'origin/strata-pub');
    const fix = git('commit-tree', 'strata-fix^{tree}', '-p', 'strata-fix', '-m', 'Fix');
    git('update-ref', 'refs/heads/strata-fix', fix);
    await reload(panel());
    ui.press("Push to new 'origin/strata-fix'");
    await run('strata.push', { ...branchMenu('strata-fix', fix), strataUpstream: true });
    assert.equal(ui.first('confirm').message, "'strata-fix' tracks origin/strata-pub, which has another name.");
    assert.equal(remote('rev-parse', 'strata-fix'), fix);
    assert.notEqual(remote('rev-parse', 'strata-pub'), fix, 'the upstream of another name is untouched');
  });

  it('pulls from and pushes to an upstream configured with a URL, keeping that configuration', async () => {
    git('push', '--quiet', bare, 'main:refs/heads/strata-url');
    git('switch', '--quiet', '--create', 'strata-url', 'main~1');
    git('config', 'branch.strata-url.remote', bare);
    git('config', 'branch.strata-url.merge', 'refs/heads/strata-url');
    await reload(panel());
    await run('strata.pull');
    assert.deepEqual(errors(), []);
    assert.equal(git('rev-parse', 'strata-url'), git('rev-parse', 'main'));

    commit('url.txt', 'url\n', 'By URL');
    await reload(panel());
    await run('strata.push');
    assert.deepEqual(errors(), []);
    assert.equal(ui.of('pick').length, 0, 'pushed where configured, not published');
    assert.equal(remote('rev-parse', 'strata-url'), git('rev-parse', 'strata-url'));
    assert.equal(git('config', 'branch.strata-url.remote'), bare);
    assert.equal(tracked('origin/strata-url'), '');
  });

  it('says when the upstream is gone from the remote, and unsets it on request', async () => {
    await publish();
    git('switch', '--quiet', 'strata-pub');
    remote('update-ref', '-d', 'refs/heads/strata-pub');
    ui.click('Unset Upstream');
    await run('strata.pull');
    await waitFor('the upstream unset', () => {
      try {
        git('config', '--get', 'branch.strata-pub.merge');
        return false;
      } catch {
        return true;
      }
    });
    const said = ui.of('notify');
    assert.equal(
      said.at(-1)?.message,
      "'origin/strata-pub', the upstream of 'strata-pub', is gone from its remote. Publish the branch again, or unset its upstream.",
    );
    assert.deepEqual(said.at(-1)?.actions, ['Publish Branch...', 'Unset Upstream']);
    assert.deepEqual(errors(), []);
  });

  it('says a pruned upstream is gone, and publishes the branch again on request', async () => {
    await publish();
    git('switch', '--quiet', 'strata-pub');
    remote('update-ref', '-d', 'refs/heads/strata-pub');
    git('fetch', '--quiet', '--prune', 'origin');
    await reload(panel());
    ui.click('Publish Branch...');
    await run('strata.pull');
    await waitFor('published again', () => remote('branch', '--list', 'strata-pub') !== '');
    assert.match(ui.first('notify').message, /is gone from its remote/);
    assert.deepEqual(errors(), []);
  });

  it("asks to pull again after signing in, since the terminal runs only the pull's fetch", async () => {
    await publish();
    git('switch', '--quiet', 'strata-pub');
    git('remote', 'set-url', 'origin', 'ssh://strata.invalid/origin.git');
    git('config', 'core.sshCommand', 'sh -c \'echo "Permission denied (publickey)." >&2; exit 255\'');
    ui.press(undefined);
    await run('strata.pull');
    assert.equal(ui.first('confirm').message, "Strata couldn't sign in to 'origin'.");
    assert.match(ui.first('confirm').detail, / to sign in there, then run Pull again\.$/);
  });

  it('pulls from an upstream that is a local branch', async () => {
    git('branch', 'strata-feat', 'main');
    git('branch', '--track', 'strata-loc', 'strata-feat');
    git('update-ref', 'refs/heads/strata-loc', 'main~1');
    git('switch', '--quiet', 'strata-loc');
    await reload(panel());
    await run('strata.pull');
    assert.deepEqual(errors(), []);
    assert.equal(git('rev-parse', 'strata-loc'), git('rev-parse', 'strata-feat'));
  });

  it('pulls from an upstream whose short name a local branch shadows', async () => {
    await publish();
    const theirs = git('commit-tree', 'strata-pub^{tree}', '-p', 'strata-pub', '-m', 'Theirs');
    git('push', '--quiet', 'origin', `${theirs}:refs/heads/strata-pub`);
    git('update-ref', 'refs/remotes/origin/strata-pub', 'strata-pub');
    git('branch', 'origin/strata-pub', 'main');
    git('switch', '--quiet', 'strata-pub');
    await reload(panel());
    await run('strata.pull');
    assert.deepEqual(errors(), []);
    assert.equal(git('rev-parse', 'refs/heads/strata-pub'), theirs);
  });

  it('pulls with rebase from where the branch forked, past upstream commits rewritten since', async () => {
    await publish();
    git('switch', '--quiet', 'strata-pub');
    commit('up.txt', 'up\n', 'Upstream one');
    git('push', '--quiet', 'origin', 'strata-pub');
    commit('mine.txt', 'mine\n', 'Mine');
    const other = join(root, 'other');
    execFileSync('git', ['clone', '--quiet', '--branch', 'strata-pub', bare, other]);
    writeFileSync(join(other, 'up.txt'), 'up, amended\n');
    execFileSync('git', [
      ...IDENTITY,
      '-C',
      other,
      'commit',
      '--quiet',
      '--all',
      '--amend',
      '-m',
      'Upstream one, amended',
    ]);
    execFileSync('git', ['-C', other, 'push', '--quiet', '--force', 'origin', 'strata-pub']);
    git('config', 'pull.rebase', 'true');
    writeFileSync(join(workspaceRoot(), 'mine.txt'), 'mine, uncommitted\n');
    await reload(panel());

    ui.press('Stash & Pull');
    await run('strata.pull');
    assert.match(ui.first('confirm').detail, /^Replays 1 commit of 'strata-pub' on top of 'origin\/strata-pub'/);
    assert.deepEqual(errors(), []);
    assert.equal(api().contextValue('strata.operation'), '');
    assert.equal(git('log', '--format=%s', '-2', 'strata-pub'), 'Mine\nUpstream one, amended');
    assert.equal(readFileSync(join(workspaceRoot(), 'mine.txt'), 'utf8'), 'mine, uncommitted\n');
  });

  it("neither types nor copies a sign-in command it can't quote for the terminal's shell", async () => {
    // A terminal running cmd.exe, which no quoting stops from splitting at '&'.
    const shell = join(root, 'bin', 'cmd');
    mkdirSync(join(root, 'bin'));
    writeFileSync(shell, '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o755 });
    const terminal = vscode.workspace.getConfiguration('terminal.integrated');
    await terminal.update('profiles.linux', { 'strata-cmd': { path: shell } }, vscode.ConfigurationTarget.Global);
    await terminal.update('defaultProfile.linux', 'strata-cmd', vscode.ConfigurationTarget.Global);
    const hook = join(workspaceRoot(), '.git', 'hooks', 'pre-push');
    writeFileSync(hook, "#!/bin/sh\necho 'Permission denied (publickey).' >&2\nexit 1\n", { mode: 0o755 });
    try {
      await waitFor('the cmd terminal profile', () => vscode.env.shell === shell);
      git('branch', 'strata-fix&docs', 'main');
      await reload(panel());
      await vscode.env.clipboard.writeText('untouched');
      const terminals = vscode.window.terminals.length;
      ui.press('Run in Terminal');
      await run('strata.publish', branchMenu('strata-fix&docs'));
      assert.equal(ui.first('confirm').message, "Strata couldn't sign in to 'origin'.");
      assert.equal(await vscode.env.clipboard.readText(), 'untouched');
      assert.equal(vscode.window.terminals.length, terminals);
      assert.match(
        ui.of('notify').at(-1)?.message ?? '',
        /^Strata can't quote this command safely for your terminal's shell\. Run it there yourself, quoted for that shell: git push --progress --set-upstream origin 'refs\/heads\/strata-fix&docs:refs\/heads\/strata-fix&docs'$/,
      );
    } finally {
      rmSync(hook, { force: true });
      await terminal.update('defaultProfile.linux', undefined, vscode.ConfigurationTarget.Global);
      await terminal.update('profiles.linux', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  const tracked = (name: string) => git('for-each-ref', `refs/remotes/${name}`);
  /** A branch on the remote at a commit of its own, fetched: `name` as in strata-x. */
  const remoteOnly = async (name: string) => {
    const only = git('commit-tree', 'main^{tree}', '-p', 'main', '-m', 'Only there');
    git('push', '--quiet', 'origin', `${only}:refs/heads/${name}`);
    await reload(panel());
    return only;
  };
  const pushFromOther = (branch: string, subject: string) => {
    const other = join(root, 'other');
    execFileSync('git', ['clone', '--quiet', '--branch', branch, bare, other]);
    execFileSync('git', [...IDENTITY, '-C', other, 'commit', '--quiet', '--allow-empty', '-m', subject]);
    execFileSync('git', ['-C', other, 'push', '--quiet', 'origin', branch]);
  };

  it('deletes a remote branch, naming the local branch that tracks it, which stays', async () => {
    await publish();
    ui.press('Delete Remote Branch');
    await run('strata.deleteRemoteBranch', remoteMenu('origin/strata-pub'));
    const asked = ui.first('confirm');
    assert.equal(asked.message, "Delete branch 'strata-pub' from 'origin'?");
    assert.match(
      asked.detail,
      / No commits are lost\. Local branch 'strata-pub' tracks it and stays\. Strata can't undo this\.$/,
    );
    assert.deepEqual(errors(), []);
    assert.equal(remote('branch', '--list', 'strata-pub'), '');
    assert.equal(tracked('origin/strata-pub'), '', 'git drops the remote-tracking branch');
    assert.ok(git('rev-parse', '--verify', 'refs/heads/strata-pub'));
  });

  it('asks again with what the remote has when someone pushed to the branch since the fetch', async () => {
    await remoteOnly('strata-x');
    pushFromOther('strata-x', 'Their fix');
    ui.press('Delete Remote Branch and Commits', 'Delete Remote Branch and Commits');
    await run('strata.deleteRemoteBranch', remoteMenu('origin/strata-x'));
    const asked = ui.of('confirm');
    assert.equal(asked.length, 2);
    assert.equal(asked[0]!.message, "Delete branch 'strata-x' from 'origin' and its 1 unmerged commit?");
    assert.match(
      asked[1]!.detail,
      /^'origin\/strata-x' changed on 'origin' since the last fetch\. 2 commits would be on no branch, newest "Their fix"/,
    );
    assert.deepEqual(errors(), []);
    assert.equal(remote('branch', '--list', 'strata-x'), '');
    assert.equal(tracked('origin/strata-x'), '');
  });

  it('keeps the remote branch when the second question is cancelled', async () => {
    await remoteOnly('strata-x');
    pushFromOther('strata-x', 'Their fix');
    ui.press('Delete Remote Branch and Commits');
    await run('strata.deleteRemoteBranch', remoteMenu('origin/strata-x'));
    assert.equal(ui.of('confirm').length, 2);
    assert.match(remote('log', '-1', '--format=%s', 'strata-x'), /^Their fix$/);
  });

  it('drops the remote-tracking branch of a branch the remote no longer has', async () => {
    await remoteOnly('strata-x');
    remote('update-ref', '-d', 'refs/heads/strata-x');
    ui.press('Delete Remote Branch and Commits');
    await run('strata.deleteRemoteBranch', remoteMenu('origin/strata-x'));
    assert.equal(ui.of('confirm').length, 1);
    assert.deepEqual(errors(), []);
    assert.equal(tracked('origin/strata-x'), '');
  });

  it('pushes a tag to the remote picked, offering the push default first', async () => {
    const mirror = join(root, 'mirror.git');
    execFileSync('git', ['init', '--quiet', '--bare', mirror]);
    git('remote', 'add', 'mirror', mirror);
    git('config', 'remote.pushDefault', 'mirror');
    git('tag', 'strata-v1', 'main~1');
    await reload(panel());
    ui.choose('origin');
    await run('strata.pushTag', tagMenu('strata-v1'));
    assert.deepEqual(ui.first('pick').items, ['mirror', 'origin']);
    assert.deepEqual(errors(), []);
    assert.equal(remote('rev-parse', 'refs/tags/strata-v1'), git('rev-parse', 'main~1'));
  });

  it('says so when the remote has a different tag of that name', async () => {
    git('push', '--quiet', 'origin', 'main~1:refs/tags/strata-v1');
    git('tag', 'strata-v1', 'main');
    await reload(panel());
    await run('strata.pushTag', tagMenu('strata-v1'));
    assert.equal(errors()[0]?.message, "'origin' already has a different tag 'strata-v1'; nothing was pushed.");
    assert.equal(remote('rev-parse', 'refs/tags/strata-v1'), git('rev-parse', 'main~1'));
  });

  it('deletes a tag from the remote picked, keeping the local tag', async () => {
    const mirror = join(root, 'mirror.git');
    execFileSync('git', ['init', '--quiet', '--bare', mirror]);
    git('remote', 'add', 'mirror', mirror);
    git('tag', 'strata-v1', 'main~1');
    git('push', '--quiet', 'origin', 'refs/tags/strata-v1');
    git('push', '--quiet', 'mirror', 'refs/tags/strata-v1');
    await reload(panel());
    ui.choose('origin').press('Delete Tag from Remote');
    await run('strata.deleteRemoteTag', tagMenu('strata-v1'));
    assert.deepEqual(ui.first('pick').items, ['origin', 'mirror']);
    assert.equal(ui.first('confirm').message, "Delete tag 'strata-v1' from 'origin'?");
    assert.deepEqual(errors(), []);
    assert.equal(remote('tag', '--list', 'strata-v1'), '');
    assert.equal(
      execFileSync('git', ['-C', mirror, 'tag', '--list', 'strata-v1'], { encoding: 'utf8' }).trim(),
      'strata-v1',
    );
    assert.equal(git('tag', '--list', 'strata-v1'), 'strata-v1');
  });

  it('fetches a remote, and pulls the current branch by fast-forwarding it', async () => {
    git('push', '--quiet', '--set-upstream', 'origin', 'main');
    git('update-ref', 'refs/heads/main', 'main~1');
    git('reset', '--hard', '--quiet');
    await reload(panel());
    await run('strata.fetch');
    assert.equal(ui.of('notify').length, 0);
    await run('strata.pull');
    assert.equal(git('rev-parse', 'main'), remote('rev-parse', 'main'));
  });
});
