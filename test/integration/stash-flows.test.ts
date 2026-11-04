import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { flowSuite, menu, reload, run } from './flow-helpers.ts';
import { git, waitFor, workspaceRoot } from './helpers.ts';
import { gitRetry } from './repo-snapshot.ts';

const notes = () => readFileSync(join(workspaceRoot(), 'NOTES.md'), 'utf8');
const stashMenu = (hash: string) => menu({ webviewSection: 'stash', strataHash: hash, strataSubject: '' });

describe('stash operations', () => {
  const { panel, ui } = flowSuite();

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

  it('selects the row that takes the place of a popped or dropped stash, and loads no more history', async () => {
    // HEAD on 400 commits more than branchy has, so the history takes more than one page.
    const main = git('rev-parse', 'main');
    const stream = Array.from({ length: 400 }, (_, i) => {
      const message = `Deep ${i}`;
      const from = i === 0 ? `from ${main}\n` : '';
      return `commit refs/heads/strata-deep\ncommitter Ada Lovelace <ada@example.com> ${1_700_010_000 + i * 60} +0000\ndata ${message.length}\n${message}\n${from}\n`;
    }).join('');
    execFileSync('git', ['fast-import', '--quiet'], { cwd: workspaceRoot(), input: stream });
    await gitRetry('switch', '--quiet', 'strata-deep');
    writeFileSync(join(workspaceRoot(), 'NOTES.md'), 'older\n');
    await gitRetry('stash', 'push', '--quiet');
    const older = git('rev-parse', 'refs/stash');
    writeFileSync(join(workspaceRoot(), 'NOTES.md'), 'newer\n');
    await gitRetry('stash', 'push', '--quiet');
    const newer = git('rev-parse', 'refs/stash');
    await reload(panel());
    await panel().simulate({ kind: 'scrollToRow', index: 0 });
    await waitFor('both stash rows at the top', async () => {
      const p = await panel().probe();
      return p.scrollTop === 0 && p.rowHashes[0] === newer && p.rowHashes[1] === older;
    });
    await panel().simulate({ kind: 'clickRow', index: 0 });
    await waitFor('stash details', async () => (await panel().probe()).detailsShown === newer);

    const pages: { generation: number; count: number }[] = [];
    const listening = panel().onDidReceiveMessage((m) => {
      if (m.type === 'loadMore') pages.push(m);
    });
    /** The graph reloaded after `action`, once it restored its selection or gave up looking for it. */
    const after = async (action: () => Promise<unknown>) => {
      const before = (await panel().probe()).generation;
      await action();
      return waitFor('reloaded', async () => {
        const p = await panel().probe();
        return p.generation > before && (p.selected !== undefined || p.done) && p;
      });
    };
    try {
      const popped = await after(() => run('strata.stash.pop', stashMenu(newer)));
      assert.equal(popped.selected, older, 'the next stash on that commit');
      assert.equal(pages.filter((m) => m.generation === popped.generation).length, 1, 'the first page only');
      assert.doesNotMatch(popped.announced, /is not in this view$/);
      await waitFor('its details', async () => (await panel().probe()).detailsShown === older);

      ui.press('Drop Stash');
      const dropped = await after(() => run('strata.stash.drop', stashMenu(older)));
      assert.equal(dropped.selected, git('rev-parse', 'HEAD'), 'the commit it was made on');
      assert.equal(pages.filter((m) => m.generation === dropped.generation).length, 1, 'the first page only');
      assert.doesNotMatch(dropped.announced, /is not in this view$/);
    } finally {
      listening.dispose();
    }
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

  it('applies the stash of its row and keeps it, leaving the other stash alone', async () => {
    const main = readFileSync(join(workspaceRoot(), 'main.txt'), 'utf8');
    writeFileSync(join(workspaceRoot(), 'NOTES.md'), 'older\n');
    git('stash', 'push', '--quiet', '--message', 'older');
    const older = git('rev-parse', 'refs/stash');
    writeFileSync(join(workspaceRoot(), 'main.txt'), 'newer\n');
    git('stash', 'push', '--quiet', '--message', 'newer');
    const newer = git('rev-parse', 'refs/stash');
    await run('strata.stash.apply', stashMenu(older));
    assert.equal(notes(), 'older\n');
    assert.equal(readFileSync(join(workspaceRoot(), 'main.txt'), 'utf8'), main);
    assert.deepEqual(git('stash', 'list', '--format=%H').split('\n'), [newer, older]);
  });

  it('creates a branch from a stash at the commit it was made on, with its changes', async () => {
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(workspaceRoot(), 'NOTES.md'), 'stashed\n');
    git('stash', 'push', '--quiet');
    const w = git('rev-parse', 'refs/stash');
    git('commit', '--quiet', '--allow-empty', '-m', 'Later');
    ui.type('strata-from-stash');
    await run('strata.stash.branch', stashMenu(w));
    assert.equal(git('branch', '--show-current'), 'strata-from-stash');
    assert.equal(git('rev-parse', 'HEAD'), base);
    assert.equal(notes(), 'stashed\n');
    assert.equal(git('stash', 'list'), '');
  });

  it('creates a branch from a stash after moving untracked files out of the way of its checkout', async () => {
    git('switch', '--quiet', '--create', 'strata-later', 'main');
    writeFileSync(join(workspaceRoot(), 'later.txt'), 'theirs\n');
    git('add', 'later.txt');
    git('commit', '--quiet', '-m', 'Later');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(workspaceRoot(), 'NOTES.md'), 'stashed\n');
    git('stash', 'push', '--quiet');
    const w = git('rev-parse', 'refs/stash');
    git('switch', '--quiet', 'main');
    writeFileSync(join(workspaceRoot(), 'later.txt'), 'mine\n');
    await reload(panel());
    ui.type('strata-from-stash').press('Stash It & Retry');
    await run('strata.stash.branch', stashMenu(w));
    assert.equal(
      ui.of('confirm')[0]?.message,
      "1 untracked file is in the way of the switch to the new branch 'strata-from-stash': later.txt.",
    );
    assert.equal(git('branch', '--show-current'), 'strata-from-stash');
    assert.equal(git('rev-parse', 'HEAD'), base);
    assert.equal(notes(), 'stashed\n');
    assert.equal(
      git('stash', 'list', '--format=%gs'),
      "On main: Strata: untracked files in the way of switch to the new branch 'strata-from-stash'",
      'the stash it was made from is gone, the one that moved later.txt stays',
    );
    assert.equal(git('show', 'stash@{0}^3:later.txt'), 'mine');
  });

  it('stashes untracked files too when asked to', async () => {
    writeFileSync(join(workspaceRoot(), 'NOTES.md'), 'changed\n');
    writeFileSync(join(workspaceRoot(), 'strata-new.txt'), 'new\n');
    ui.type('with new');
    await run('strata.stash.pushUntracked');
    assert.equal(git('stash', 'list', '--format=%gs'), 'On main: with new');
    assert.equal(git('show', 'stash@{0}^3:strata-new.txt'), 'new');
    assert.equal(git('status', '--porcelain'), '');
  });

  it('applies nothing of a stash whose untracked files exist here, says which, and applies once they are gone', async () => {
    const before = notes();
    writeFileSync(join(workspaceRoot(), 'NOTES.md'), 'changed\n');
    writeFileSync(join(workspaceRoot(), 'strata-new.txt'), 'new\n');
    git('stash', 'push', '--quiet', '--include-untracked', '--message', 'with new');
    const w = git('rev-parse', 'refs/stash');
    writeFileSync(join(workspaceRoot(), 'strata-new.txt'), 'mine\n');
    await reload(panel());
    await run('strata.stash.pop', stashMenu(w));
    assert.deepEqual(ui.of('notify'), [
      {
        kind: 'notify',
        level: 'error',
        message:
          'stash@{0} ("On main: with new") adds a file that already exists here: strata-new.txt. Move it away and apply again.',
        actions: [],
      },
    ]);
    assert.equal(notes(), before, 'nothing applied');
    assert.equal(readFileSync(join(workspaceRoot(), 'strata-new.txt'), 'utf8'), 'mine\n');
    assert.equal(git('rev-parse', 'refs/stash'), w);

    ui.clear();
    rmSync(join(workspaceRoot(), 'strata-new.txt'));
    await run('strata.stash.apply', stashMenu(w));
    assert.deepEqual(
      ui.of('notify').filter((n) => n.level !== 'info'),
      [],
    );
    assert.equal(notes(), 'changed\n');
    assert.equal(readFileSync(join(workspaceRoot(), 'strata-new.txt'), 'utf8'), 'new\n');
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
