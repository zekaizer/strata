import * as assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { commitMenu, flowSuite, menu, reload, run } from './flow-helpers.ts';
import { git, waitFor, workspaceRoot } from './helpers.ts';

const write = (file: string, content: string) => {
  writeFileSync(join(workspaceRoot(), file), content);
};
const commitFile = (file: string, content: string, message = `${file}: ${content.trim()}`) => {
  write(file, content);
  git('add', file);
  git('commit', '--quiet', '-m', message);
  return git('rev-parse', 'HEAD');
};
const short = (rev: string) => git('rev-parse', '--short', rev);
const message = (rev: string) => git('log', '-1', '--format=%B', rev);
const saveEdit = (kind: 'reword' | 'squash', hashes: string[], text: string, head = git('rev-parse', 'HEAD')) =>
  run(
    'strata.saveEdit',
    menu({ strataEdit: kind, strataHashes: hashes.join(' '), strataHead: head, strataMessage: text }),
  );
const selection = (newestFirst: string[]) =>
  menu({ webviewSection: 'selection', strataHash: newestFirst[0], strataSelection: newestFirst.join(' ') });

describe('tidying recent commits', () => {
  const { panel, ui } = flowSuite();

  /** Three commits a, b, c on main, each adding its own file; resolves their ids. */
  const three = async () => {
    const ids = [commitFile('a.txt', 'a\n'), commitFile('b.txt', 'b\n'), commitFile('c.txt', 'c\n')];
    await reload(panel());
    return ids as [string, string, string];
  };

  it('edits the message of an older commit without touching the work tree, the index or file times', async () => {
    const [a, , c] = await three();
    write('a.txt', 'changed\n');
    write('new.txt', 'staged\n');
    git('add', 'new.txt');
    const mtime = statSync(join(workspaceRoot(), 'c.txt')).mtimeMs;
    const status = git('status', '--porcelain');
    await run('strata.editMessage', commitMenu(a));
    await saveEdit('reword', [a], 'a.txt: better words\n\nWith a body.  \n\n');
    assert.equal(ui.of('confirm').length, 0, 'nothing pushed, no other branch: nothing to ask');
    assert.equal(message('HEAD~2'), 'a.txt: better words\n\nWith a body.');
    assert.equal(git('rev-parse', 'HEAD^{tree}'), git('rev-parse', `${c}^{tree}`));
    assert.equal(git('log', '-1', '--format=%an %ad', 'HEAD~2'), git('log', '-1', '--format=%an %ad', a));
    assert.equal(git('status', '--porcelain'), status);
    assert.equal(statSync(join(workspaceRoot(), 'c.txt')).mtimeMs, mtime);
    assert.equal(git('reflog', '-1', '--format=%gs', 'main'), 'strata: message edit');
    assert.equal(ui.of('notify').at(-1)?.message, `Edited the message of ${short(a)} (now ${short('HEAD~2')})`);
    await run('strata.undo');
    assert.equal(git('rev-parse', 'HEAD'), c);
    assert.equal(git('status', '--porcelain'), status, 'Undo keeps the staged new file staged');
  });

  it('squashes a run into its oldest commit, with its author and the newest tree', async () => {
    const [a, , c] = await three();
    await saveEdit('squash', [a, git('rev-parse', 'HEAD~1'), c], 'all three\n');
    assert.equal(git('rev-parse', 'HEAD^{tree}'), git('rev-parse', `${c}^{tree}`));
    assert.equal(git('rev-parse', 'HEAD~1'), git('rev-parse', `${a}~1`));
    assert.equal(message('HEAD'), 'all three');
    assert.equal(git('log', '-1', '--format=%ad', 'HEAD'), git('log', '-1', '--format=%ad', a));
    assert.match(ui.of('notify').at(-1)?.message ?? '', /^Squashed 3 commits into /);
  });

  it('moves another branch on a rewritten commit along, and leaves a tag', async () => {
    const [a, b] = await three();
    git('branch', 'strata-at-b', b);
    git('tag', 'strata-tag-b', b);
    await reload(panel());
    ui.press('Save and Move strata-at-b');
    await saveEdit('reword', [a], 'a reworded\n');
    const asked = ui.first('confirm');
    assert.equal(asked.message, `Save the new message of ${short(a)}?`);
    assert.match(asked.detail, /Tag 'strata-tag-b' stays on the old commits\./);
    assert.deepEqual(asked.buttons, ['Save and Move strata-at-b', 'Save Only']);
    assert.equal(git('rev-parse', 'strata-at-b'), git('rev-parse', 'HEAD~1'));
    assert.equal(git('rev-parse', 'strata-tag-b'), b);
    await run('strata.undo');
    assert.equal(git('rev-parse', 'strata-at-b'), b, 'Undo moves it back too');
  });

  it('leaves a branch checked out in another worktree on the old commits, and says so', async () => {
    const [a, b] = await three();
    const elsewhere = mkdtempSync(join(tmpdir(), 'strata-wt-'));
    git('worktree', 'add', '--quiet', '-b', 'strata-wt', join(elsewhere, 'wt'), b);
    try {
      await reload(panel());
      ui.press('Save');
      await saveEdit('reword', [a], 'a reworded\n');
      const asked = ui.first('confirm');
      assert.match(asked.detail, /'strata-wt' is checked out in another worktree and keeps the old commits\./);
      assert.deepEqual(asked.buttons, ['Save']);
      assert.equal(git('rev-parse', 'strata-wt'), b);
      assert.equal(message('HEAD~2'), 'a reworded');
    } finally {
      git('worktree', 'remove', '--force', join(elsewhere, 'wt'));
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('warns before rewriting commits a remote-tracking branch has', async () => {
    const [a, b] = await three();
    git('update-ref', 'refs/remotes/origin/strata-pushed', b);
    await reload(panel());
    await saveEdit('reword', [a], 'pushed\n');
    const asked = ui.first('confirm');
    assert.equal(asked.message, "Rewrite 2 commits that 'origin/strata-pushed' already has?");
    assert.deepEqual(asked.buttons, ['Save Anyway']);
    assert.match(asked.detail, /^Force pushes are off: the git\.allowForcePush setting allows them\.$/m);
    assert.notEqual(message(a), 'pushed', 'cancelled: nothing changed');
    assert.equal(git('rev-parse', 'HEAD~2'), a);
  });

  it('runs the commit-msg hook on the message it writes, and stops when the hook refuses', async () => {
    const [a] = await three();
    const hooks = mkdtempSync(join(tmpdir(), 'strata-hooks-'));
    const hook = join(hooks, 'commit-msg');
    writeFileSync(hook, '#!/bin/sh\nprintf "\\nChange-Id: I0123\\n" >> "$1"\n');
    chmodSync(hook, 0o755);
    git('config', 'core.hooksPath', hooks);
    try {
      await saveEdit('reword', [a], 'with id\n');
      assert.equal(message('HEAD~2'), 'with id\n\nChange-Id: I0123');
      assert.equal(message('HEAD~1'), 'b.txt: b', 'the hook runs only on messages Strata writes');
      const head = git('rev-parse', 'HEAD');
      writeFileSync(hook, '#!/bin/sh\necho "no ticket" >&2\nexit 1\n');
      await saveEdit('reword', [git('rev-parse', 'HEAD~2')], 'refused\n');
      assert.equal(git('rev-parse', 'HEAD'), head);
      await waitFor('the refusal', () =>
        ui.of('notify').some((n) => n.level === 'error' && /no ticket/.test(n.message)),
      );
    } finally {
      rmSync(hooks, { recursive: true, force: true });
    }
  });

  it('signs as commit.gpgSign asks, and moves nothing when signing fails', async () => {
    const [a, , c] = await three();
    git('config', 'commit.gpgSign', 'true');
    git('config', 'gpg.program', 'false');
    await saveEdit('reword', [a], 'signed\n');
    assert.equal(git('rev-parse', 'HEAD'), c);
    await waitFor('the failure', () => ui.of('notify').some((n) => n.level === 'error'));
  });

  it('refuses a save once HEAD moved since the editor opened, keeping the message', async () => {
    const [a] = await three();
    const opened = git('rev-parse', 'HEAD');
    commitFile('d.txt', 'd\n');
    await saveEdit('reword', [a], 'late\n', opened);
    assert.match(ui.of('notify').at(-1)?.message ?? '', /changed since the editor opened/);
    assert.equal(git('rev-parse', 'HEAD~3'), a);
  });

  it('fixes a commit up into its parent in place, keeping the parent message', async () => {
    const [a, b, c] = await three();
    await run('strata.fixupIntoParent', commitMenu(b));
    assert.equal(message('HEAD~1'), message(a));
    assert.equal(git('rev-parse', 'HEAD^{tree}'), git('rev-parse', `${c}^{tree}`));
    assert.equal(git('ls-tree', '--name-only', 'HEAD~1', 'b.txt'), 'b.txt');
    assert.equal(ui.of('notify').at(-1)?.message, `Fixed up ${short(b)} into ${short(a)}`);
  });

  it('fixes a commit up into an older one through a rebase, and undoes it', async () => {
    const [a, , c] = await three();
    ui.choose('a.txt: a');
    await run('strata.fixupIntoOlder', commitMenu(c));
    assert.equal(ui.first('pick').items[0], 'b.txt: b');
    assert.equal(git('rev-list', '--count', `${a}~1..HEAD`), '2');
    assert.equal(git('ls-tree', '--name-only', 'HEAD~1', 'c.txt'), 'c.txt');
    await run('strata.undo');
    assert.equal(git('rev-parse', 'HEAD'), c);
  });

  it('stops at a conflicting fixup, which Continue goes on from', async () => {
    const a = commitFile('f.txt', 'a\n');
    commitFile('f.txt', 'b\n');
    const c = commitFile('f.txt', 'c\n');
    await reload(panel());
    ui.choose('f.txt: a');
    await run('strata.fixupIntoOlder', commitMenu(c));
    const stops = () => ui.of('notify').filter((n) => n.level === 'warning' && n.actions.includes('Resolve...'));
    await waitFor('the stop at the fixup', () => stops().length === 1);
    write('f.txt', 'c\n');
    git('add', 'f.txt');
    await run('strata.operation.continue');
    await waitFor('the stop at the commit replayed after it', () => stops().length === 2);
    write('f.txt', 'b\n');
    git('add', 'f.txt');
    await run('strata.operation.continue');
    await waitFor('the end of the rebase', () => !git('status').includes('rebase'));
    assert.deepEqual(git('log', '--format=%s', '-2').split('\n'), ['f.txt: b', 'f.txt: a']);
    assert.equal(git('rev-parse', 'HEAD~2'), git('rev-parse', `${a}~1`));
    assert.equal(git('show', 'HEAD~1:f.txt'), 'c', 'the fixup melded into the older commit');
  });

  it('drops selected commits after asking, carrying uncommitted changes through', async () => {
    const [a, b, c] = await three();
    write('a.txt', 'dirty\n');
    ui.press('Stash & Drop');
    await run('strata.dropSelected', selection([c, b]));
    const asked = ui.first('confirm');
    assert.equal(asked.message, "Drop 2 commits from 'main'?");
    assert.equal(git('rev-parse', 'HEAD'), a);
    assert.equal(readFileSync(join(workspaceRoot(), 'a.txt'), 'utf8'), 'dirty\n');
    assert.equal(ui.of('notify').at(-1)?.message, "Dropped 2 commits from 'main'");
  });

  it('drops a commit below others, and refuses one that is not on the current branch', async () => {
    const [, b] = await three();
    ui.press('Drop');
    await run('strata.dropCommit', commitMenu(b));
    assert.deepEqual(git('log', '--format=%s', '-2').split('\n'), ['c.txt: c', 'a.txt: a']);
    git('branch', 'strata-side', 'HEAD~1');
    git('switch', '--quiet', 'strata-side');
    const side = commitFile('s.txt', 's\n');
    git('switch', '--quiet', 'main');
    await reload(panel());
    await run('strata.dropCommit', commitMenu(side));
    assert.match(ui.of('notify').at(-1)?.message ?? '', /is not on the first-parent line of 'main'/);
  });

  it('copies the hashes of a selection', async () => {
    const [, b, c] = await three();
    await run('strata.copySelectedHashes', selection([c, b]));
    assert.equal(ui.of('notify').length, 0);
  });

  /** The row index of commit `hash` once the graph draws it. */
  const rowOf = (hash: string) =>
    waitFor(`the row of ${hash}`, async () => {
      const p = await panel().probe();
      const i = Object.entries(p.rowHashes).find(([, h]) => h === hash)?.[0];
      return i === undefined ? undefined : Number(i);
    });

  it('edits a message in the inline editor and saves it', async () => {
    const [a] = await three();
    await run('strata.editMessage', commitMenu(a));
    const opened = await waitFor('the editor, then what saving rewrites', async () => {
      const p = await panel().probe();
      return p.editor?.shown && p.editor.status.includes('pushed') && p;
    });
    assert.equal(opened.selected, a);
    const ed = opened.editor;
    assert.ok(ed);
    assert.equal(ed.text, 'a.txt: a\n');
    assert.match(ed.status, /^Subject 8\/72 · 2 newer commits are rewritten on top · Nothing was pushed/);
    await panel().simulate({ kind: 'type', selector: '.message-editor', text: 'a.txt: written inline\n' });
    await panel().simulate({ kind: 'click', selector: '.tidy-actions .button.primary' });
    await waitFor('the new message', () => message('HEAD~2') === 'a.txt: written inline');
    await waitFor('the editor to close', async () => (await panel().probe()).editor === undefined);
  });

  it('cancels the editor with Escape, leaving the history alone', async () => {
    const [a] = await three();
    await run('strata.editMessage', commitMenu(a));
    await waitFor('the editor', async () => (await panel().probe()).editor?.shown);
    await panel().simulate({ kind: 'key', key: 'Escape', target: 'focused' });
    await waitFor('the editor to close', async () => (await panel().probe()).editor === undefined);
    assert.equal(git('rev-parse', 'HEAD~2'), a);
  });

  it('selects a run with Shift-click and squashes it from its panel', async () => {
    const [a, b, c] = await three();
    await panel().simulate({ kind: 'clickRow', index: await rowOf(c) });
    await panel().simulate({ kind: 'clickRow', index: await rowOf(a), shiftKey: true });
    const p = await waitFor('the selection panel', async () => {
      const probe = await panel().probe();
      return probe.selectionPanel && probe;
    });
    assert.deepEqual(p.selection, [c, b, a]);
    assert.equal(p.selected, a, 'the panel opens under the oldest');
    assert.ok(p.outOfReach.length > 0, 'commits past the first merge step back');
    assert.equal(p.menuContexts.selectedRow?.['webviewSection'], 'selection');
    await panel().simulate({ kind: 'click', selector: '.tidy-actions .button.primary' });
    const ed = await waitFor('the squash editor', async () => {
      const probe = await panel().probe();
      return probe.editor?.shown && probe.editor;
    });
    assert.deepEqual(ed.commits, [a, b, c]);
    assert.equal(ed.save, 'Squash 3 Commits');
    await panel().simulate({ kind: 'click', selector: '.tidy-commits .icon-button' });
    await panel().simulate({ kind: 'click', selector: '.tidy-actions .button.primary' });
    await waitFor('the squash', () => git('rev-parse', 'HEAD~1') === git('rev-parse', `${a}~1`));
    assert.equal(message('HEAD'), 'a.txt: a\n\nb.txt: b');
  });

  it('says which commits can be selected together when Shift-click reaches past them', async () => {
    const [a, , c] = await three();
    await panel().simulate({ kind: 'clickRow', index: await rowOf(c) });
    await panel().simulate({ kind: 'clickRow', index: await rowOf(a), shiftKey: true });
    const run = await waitFor('the selection', async () => {
      const probe = await panel().probe();
      return probe.selection.length === 3 && probe.outOfReach.length > 0 && probe;
    });
    const beyond = run.outOfReach[0]!;
    await panel().simulate({ kind: 'clickRow', index: beyond, shiftKey: true });
    const p = await waitFor('the selection of one row', async () => {
      const probe = await panel().probe();
      return probe.selected === run.rowHashes[beyond] && probe;
    });
    assert.deepEqual(p.selection, []);
    assert.match(p.status, /first-parent line, from HEAD down to the first merge/);
    assert.equal(p.announced, p.status);
  });

  it('ends a Shift-click selection when find jumps to a match elsewhere', async () => {
    const [a, , c] = await three();
    await panel().simulate({ kind: 'clickRow', index: await rowOf(c) });
    await panel().simulate({ kind: 'clickRow', index: await rowOf(a), shiftKey: true });
    await waitFor('the selection', async () => (await panel().probe()).selection.length === 3);
    await panel().simulate({ kind: 'click', selector: '.find-button' });
    await panel().simulate({ kind: 'type', selector: '.find-input', text: 'Initial commit' });
    await panel().simulate({ kind: 'key', key: 'Enter', target: 'focused' });
    const p = await waitFor('the jump', async () => {
      const probe = await panel().probe();
      return probe.selected !== a && probe.selected !== undefined && probe;
    });
    assert.deepEqual(p.selection, []);
    assert.equal(p.outOfReach.length, 0);
    assert.equal(p.selectionPanel, false);
    await panel().simulate({ kind: 'key', key: 'Escape', target: 'focused' });
  });

  it('offers no rewriting from a merge down in first-parent history, which shows the merge with one parent', async () => {
    const [, , c] = await three();
    const merge = git('rev-list', '--first-parent', '--merges', '--max-count=1', 'HEAD');
    const below = git('rev-parse', `${merge}^1`);
    const gen = (await panel().probe()).generation;
    await panel().simulate({ kind: 'click', selector: '.first-parent-button' });
    await waitFor('first-parent history', async () => {
      const p = await panel().probe();
      return p.generation > gen && p.options.firstParent && p.done;
    });
    const rewritable = async (hash: string) => {
      await panel().simulate({ kind: 'clickRow', index: await rowOf(hash) });
      const p = await waitFor(`${hash} selected`, async () => {
        const probe = await panel().probe();
        return probe.selected === hash && probe;
      });
      return p.menuContexts.selectedRow?.['strataRewritable'];
    };
    assert.equal(await rewritable(c), true);
    assert.equal(await rewritable(merge), false);
    assert.equal(await rewritable(below), false);
    await panel().simulate({ kind: 'click', selector: '.first-parent-button' });
    await waitFor('the whole history again', async () => !(await panel().probe()).options.firstParent);
  });

  it('offers no rewriting in a file history, whose rows are not the commit history, and says why', async () => {
    const [a, , c] = await three();
    const gen = (await panel().probe()).generation;
    await run('strata.showHistory', vscode.Uri.file(join(workspaceRoot(), 'a.txt')));
    await waitFor('the file history', async () => {
      const p = await panel().probe();
      return p.generation > gen && p.done && p.options.path !== null;
    });
    await panel().simulate({ kind: 'clickRow', index: await rowOf(c) });
    await panel().simulate({ kind: 'clickRow', index: await rowOf(a), shiftKey: true });
    const p = await waitFor('the selection of one row', async () => {
      const probe = await panel().probe();
      return probe.selected === a && probe;
    });
    assert.deepEqual(p.selection, []);
    assert.match(p.status, /needs the whole history: clear the path filter first/);
    assert.equal(p.menuContexts.selectedRow?.['strataRewritable'], false);
    await panel().simulate({ kind: 'click', selector: '.path-chip-clear' });
    await waitFor('the whole history again', async () => (await panel().probe()).options.path === null);
  });
});
