import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { branchMenu, flowSuite, reload, run } from './flow-helpers.ts';
import { git, workspaceRoot } from './helpers.ts';

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

    ui.press('Stash & Rebase');
    await run('strata.pull');
    assert.match(ui.first('confirm').detail, /^Replays 1 commit of 'strata-pub' on top of 'origin\/strata-pub'/);
    assert.deepEqual(errors(), []);
    assert.equal(api().contextValue('strata.operation'), '');
    assert.equal(git('log', '--format=%s', '-2', 'strata-pub'), 'Mine\nUpstream one, amended');
    assert.equal(readFileSync(join(workspaceRoot(), 'mine.txt'), 'utf8'), 'mine, uncommitted\n');
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
