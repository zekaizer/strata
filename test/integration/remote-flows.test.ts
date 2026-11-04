import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { branchMenu, flowSuite, reload, run } from './flow-helpers.ts';
import { git } from './helpers.ts';

const IDENTITY = ['-c', 'user.name=Other Person', '-c', 'user.email=other@example.com'];

describe('remote operations', () => {
  const { panel, ui } = flowSuite();
  let root: string;
  let bare: string;
  const remote = (...args: string[]) => execFileSync('git', args, { cwd: bare, encoding: 'utf8' }).trim();

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
