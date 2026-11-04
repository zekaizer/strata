import * as assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { flowSuite, menu, run } from './flow-helpers.ts';
import { git, workspaceRoot } from './helpers.ts';

const notes = () => readFileSync(join(workspaceRoot(), 'NOTES.md'), 'utf8');
const stashMenu = (hash: string) => menu({ webviewSection: 'stash', strataHash: hash, strataSubject: '' });

describe('stash operations', () => {
  const { ui } = flowSuite();

  it('says when there is nothing to stash', async () => {
    await run('strata.stash.push');
    assert.deepEqual(ui.asked, [{ kind: 'notify', level: 'info', message: 'No local changes to stash.', actions: [] }]);
  });

  it('stashes, pops, drops and brings a dropped stash back with Undo', async () => {
    writeFileSync(join(workspaceRoot(), 'NOTES.md'), 'mine\n');
    ui.type('my work');
    await run('strata.stash.push');
    assert.equal(ui.first('input').prompt, 'Message (optional). Stashes 1 changed file.');
    assert.equal(git('stash', 'list', '--format=%gs'), 'On main: my work');
    assert.equal(git('status', '--porcelain', '--untracked-files=no'), '');
    assert.equal(ui.of('notify').length, 0, 'a push is reported in the status bar only');

    const w = git('rev-parse', 'refs/stash');
    await run('strata.stash.pop', stashMenu(w));
    assert.equal(notes(), 'mine\n');
    assert.equal(git('stash', 'list'), '');

    ui.clear();
    ui.type('');
    await run('strata.stash.push');
    const again = git('rev-parse', 'refs/stash');
    ui.press('Drop Stash');
    await run('strata.stash.drop', stashMenu(again));
    assert.match(ui.first('confirm').message, /^Drop stash@\{0\} \("WIP on main: /);
    assert.match(ui.first('confirm').detail, /^1 changed file on [0-9a-f]+ "/);
    assert.equal(git('stash', 'list'), '');
    await run('strata.undo');
    assert.equal(git('rev-parse', 'refs/stash'), again, 'the same stash is back');
  });

  it('tells a pop that conflicts from one that worked, and keeps the stash', async () => {
    writeFileSync(join(workspaceRoot(), 'NOTES.md'), 'stashed\n');
    git('stash', 'push', '--quiet');
    const w = git('rev-parse', 'refs/stash');
    writeFileSync(join(workspaceRoot(), 'NOTES.md'), 'committed\n');
    git('commit', '--quiet', '-am', 'change notes');
    await run('strata.stash.pop', stashMenu(w));
    assert.equal(git('rev-parse', 'refs/stash'), w, 'git kept it');
    assert.match(
      ui.of('notify').find((n) => n.level === 'warning')?.message ?? '',
      /^Popped stash@\{0\} \("WIP on main: .*"\), but restoring your stashed changes conflicted in 1 file \(NOTES\.md\)\./,
    );
  });

  it('copies the patch of a stash, untracked files included', async () => {
    writeFileSync(join(workspaceRoot(), 'NOTES.md'), 'changed\n');
    writeFileSync(join(workspaceRoot(), 'strata-new.txt'), 'new\n');
    git('stash', 'push', '--quiet', '--include-untracked');
    await run('strata.stash.copyPatch', stashMenu(git('rev-parse', 'refs/stash')));
    const patch = await vscode.env.clipboard.readText();
    assert.match(patch, /^diff --git a\/NOTES\.md b\/NOTES\.md$/m);
    assert.match(patch, /^diff --git a\/strata-new\.txt b\/strata-new\.txt$/m);
  });
});
