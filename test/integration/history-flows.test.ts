import * as assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { branchMenu, commitMenu, flowSuite, menu, reload, run, selected } from './flow-helpers.ts';
import { git, waitFor, workspaceRoot } from './helpers.ts';

const write = (file: string, content: string) => {
  writeFileSync(join(workspaceRoot(), file), content);
};
const read = (file: string) => readFileSync(join(workspaceRoot(), file), 'utf8');
/** A branch from `from` with one commit writing `file`. */
const branchWith = (branch: string, from: string, file: string, content: string) => {
  git('switch', '--quiet', '--create', branch, from);
  write(file, content);
  git('add', file);
  git('commit', '--quiet', '-m', `${file}: ${content.trim()}`);
};
/** A commit on HEAD writing `file`; resolves its id. */
const commitFile = (file: string, content: string) => {
  write(file, content);
  git('add', file);
  git('commit', '--quiet', '-m', `${file}: ${content.trim()}`);
  return git('rev-parse', 'HEAD');
};
/** Runs `git rebase -i onto` from the command line with `todo` as its todo list. */
const rebaseInteractive = (onto: string, todo: string[]) => {
  const dir = mkdtempSync(join(tmpdir(), 'strata-todo-'));
  const file = join(dir, 'todo');
  writeFileSync(file, `${todo.join('\n')}\n`);
  spawnSync('git', ['rebase', '-i', onto], {
    cwd: workspaceRoot(),
    env: { ...process.env, GIT_SEQUENCE_EDITOR: `cp '${file}'`, GIT_EDITOR: 'true' },
  });
  rmSync(dir, { recursive: true });
};

describe('history operations', () => {
  const { api, panel, ui } = flowSuite();

  /** A commit on main~1 whose main.txt conflicts with main's; HEAD stays on main. */
  const conflicting = async () => {
    branchWith('strata-pick', 'main~1', 'main.txt', 'picked\n');
    git('switch', '--quiet', 'main');
    await reload(panel());
    return git('rev-parse', 'strata-pick');
  };
  const leftover = () =>
    panel()
      .probe()
      .then((p) => p.leftover);

  it('fast-forwards the current branch, and undoes that', async () => {
    branchWith('strata-ahead', 'main', 'ahead.txt', 'ahead\n');
    git('switch', '--quiet', 'main');
    await reload(panel());
    const before = git('rev-parse', 'main');
    const ahead = git('rev-parse', 'strata-ahead');
    ui.press('Fast-Forward');
    await run('strata.merge', branchMenu('strata-ahead', ahead));
    const asked = ui.first('confirm');
    assert.equal(asked.message, "Merge 'strata-ahead' into 'main'?");
    assert.deepEqual(asked.buttons, ['Fast-Forward', 'Create Merge Commit']);
    assert.equal(git('rev-parse', 'main'), ahead);
    await selected(panel(), ahead);
    assert.equal(ui.of('notify').at(-1)?.message, `Fast-forwarded 'main' to ${git('rev-parse', '--short', ahead)}`);
    await run('strata.undo');
    assert.equal(git('rev-parse', 'main'), before);
  });

  it('asks before an Undo that would drop commits made since, and drops them only when told to', async () => {
    branchWith('strata-ahead', 'main', 'ahead.txt', 'ahead\n');
    git('switch', '--quiet', 'main');
    await reload(panel());
    const before = git('rev-parse', 'main');
    ui.press('Fast-Forward');
    await run('strata.merge', branchMenu('strata-ahead', git('rev-parse', 'strata-ahead')));
    write('later.txt', 'later\n');
    git('add', 'later.txt');
    git('commit', '--quiet', '-m', 'Later');
    const later = git('rev-parse', 'main');

    ui.clear();
    await run('strata.undo');
    assert.equal(
      ui.first('confirm').message,
      `'main' has moved since the merge (now at ${git('rev-parse', '--short', later)}).`,
    );
    assert.equal(git('rev-parse', 'main'), later);

    ui.clear();
    ui.press('Undo Anyway');
    await run('strata.undo');
    assert.equal(git('rev-parse', 'main'), before);
  });

  it('records a merge commit when asked to', async () => {
    branchWith('strata-ahead', 'main', 'ahead.txt', 'ahead\n');
    git('switch', '--quiet', 'main');
    await reload(panel());
    ui.press('Create Merge Commit');
    await run('strata.merge', branchMenu('strata-ahead', git('rev-parse', 'strata-ahead')));
    assert.equal(git('rev-list', '--parents', '-n1', 'HEAD').split(' ').length, 3);
    assert.equal(git('log', '-1', '--format=%s'), "Merge branch 'strata-ahead'");
  });

  it('merges the clicked branch when a tag has the same name', async () => {
    branchWith('strata-rel', 'main', 'tagged.txt', 'tagged\n');
    git('tag', 'strata-rel');
    write('branch.txt', 'branch\n');
    git('add', 'branch.txt');
    git('commit', '--quiet', '-m', 'Branch tip');
    git('switch', '--quiet', 'main');
    await reload(panel());
    const tip = git('rev-parse', 'refs/heads/strata-rel');
    ui.press('Create Merge Commit');
    await run('strata.merge', branchMenu('strata-rel', tip));
    assert.equal(git('rev-parse', 'HEAD^2'), tip);
    assert.match(git('log', '-1', '--format=%s'), /^Merge branch /);
  });

  it('stops a rebase at a conflict, reports it, holds other writes, and aborts back', async () => {
    branchWith('strata-topic', 'main~1', 'main.txt', 'topic\n');
    const tip = git('rev-parse', 'HEAD');
    ui.press('Rebase');
    await run('strata.rebase', branchMenu('main', git('rev-parse', 'main')));
    assert.match(ui.first('confirm').detail, /^Replays 1 commit of 'strata-topic' on top of 'main'/);
    assert.deepEqual(ui.of('notify').at(-1), {
      kind: 'notify',
      level: 'warning',
      message: 'Rebase stopped at 1 of 1 ("main.txt: topic") with conflicts in 1 file (main.txt).',
      actions: ['Resolve...', 'Abort Rebase...'],
    });
    assert.equal(api().contextValue('strata.operation'), 'rebase');
    await waitFor('rebase reported', async () => (await panel().probe()).operation?.kind === 'rebase');

    ui.clear();
    await run('strata.createBranch', commitMenu(git('rev-parse', 'main')));
    assert.equal(ui.first('confirm').message, 'A rebase is in progress (stopped at 1 of 1).');
    assert.equal(ui.of('input').length, 0, 'the branch was not asked for');

    ui.clear();
    ui.press('Abort Rebase');
    await run('strata.operation.abort');
    assert.equal(ui.first('confirm').message, 'Abort the rebase?');
    assert.equal(git('branch', '--show-current'), 'strata-topic');
    assert.equal(git('rev-parse', 'HEAD'), tip);
    assert.equal(api().contextValue('strata.operation'), '');
    await waitFor('rebase gone', async () => (await panel().probe()).operation === undefined);
  });

  /** A rebase of strata-topic stopped at a conflict, with NOTES.md edited and added.txt added since. */
  const editedWhileStopped = async () => {
    branchWith('strata-topic', 'main~1', 'main.txt', 'topic\n');
    const tip = git('rev-parse', 'HEAD');
    const notes = read('NOTES.md');
    ui.press('Rebase');
    await run('strata.rebase', branchMenu('main', git('rev-parse', 'main')));
    assert.equal(api().contextValue('strata.operation'), 'rebase');
    write('NOTES.md', 'mine\n');
    write('added.txt', 'added\n');
    git('add', 'added.txt');
    ui.clear();
    return { tip, notes };
  };
  const announced = (pattern: RegExp) =>
    waitFor(`announced ${pattern}`, async () => pattern.test((await panel().probe()).announced));

  it('keeps the changes made while a rebase stopped in a stash when Abort would discard them', async () => {
    const { tip } = await editedWhileStopped();
    ui.press('Stash Changes & Abort');
    await run('strata.operation.abort');
    const asked = ui.first('confirm');
    assert.match(
      asked.detail,
      / Your uncommitted changes in 2 files \(NOTES\.md and added\.txt\) would be discarded: Stash Changes & Abort keeps them in the stash list; Discard Changes & Abort throws them away\.$/,
    );
    assert.deepEqual(asked.buttons, ['Stash Changes & Abort', 'Discard Changes & Abort']);
    assert.equal(git('rev-parse', 'HEAD'), tip);
    assert.equal(git('stash', 'list', '--format=%gs'), 'On strata-topic: Strata: before abort of the rebase');
    assert.equal(git('show', 'stash@{0}:NOTES.md'), 'mine');
    assert.equal(git('show', 'stash@{0}^2:added.txt'), 'added', 'staged, as it was');
    await announced(
      /^Aborted the rebase\. Your uncommitted changes are in stash@\{0\} \("On strata-topic: Strata: before abort of the rebase"\)$/,
    );
  });

  it('discards the changes made while a rebase stopped only when told to', async () => {
    const { tip, notes } = await editedWhileStopped();
    ui.press('Discard Changes & Abort');
    await run('strata.operation.abort');
    assert.equal(git('rev-parse', 'HEAD'), tip);
    assert.equal(read('NOTES.md'), notes);
    assert.equal(git('stash', 'list'), '');
  });

  it('keeps the changes made while a rebase stopped in a stash when Skip would discard them', async () => {
    const { tip } = await editedWhileStopped();
    ui.press('Stash Changes & Skip');
    await run('strata.operation.skip');
    assert.deepEqual(ui.first('confirm').buttons, ['Stash Changes & Skip', 'Discard Changes & Skip']);
    assert.equal(api().contextValue('strata.operation'), '');
    assert.equal(
      git('stash', 'list', '--format=%gs'),
      `On strata-topic: Strata: before skip of ${git('rev-parse', '--short', tip)}`,
    );
    assert.equal(git('show', 'stash@{0}:NOTES.md'), 'mine');
  });

  it('asks nothing about unstaged changes a cherry pick Abort keeps', async () => {
    const picked = await conflicting();
    await run('strata.cherryPick', commitMenu(picked));
    assert.equal(api().contextValue('strata.operation'), 'cherryPick');
    write('NOTES.md', 'mine\n');
    ui.clear();
    ui.press('Abort Cherry Pick');
    await run('strata.operation.abort');
    assert.deepEqual(ui.first('confirm').buttons, ['Abort Cherry Pick']);
    assert.equal(api().contextValue('strata.operation'), '');
    assert.equal(read('NOTES.md'), 'mine\n');
    assert.equal(git('stash', 'list'), '');
  });

  it('names where Abort really goes for a cherry pick of several commits, and the commits it drops', async () => {
    const start = git('rev-parse', 'HEAD');
    branchWith('strata-picks', 'main~1', 'first.txt', 'first\n');
    write('main.txt', 'picked\n');
    git('commit', '--quiet', '-am', 'main.txt: picked');
    write('third.txt', 'third\n');
    git('add', 'third.txt');
    git('commit', '--quiet', '-m', 'third');
    git('switch', '--quiet', 'main');
    spawnSync('git', ['cherry-pick', 'strata-picks~2', 'strata-picks~1', 'strata-picks'], { cwd: workspaceRoot() });
    assert.equal(git('rev-parse', 'HEAD~1'), start, 'stopped at the second, the first picked');
    await reload(panel());
    ui.press('Abort Cherry Pick');
    await run('strata.operation.abort');
    assert.match(
      ui.first('confirm').detail,
      new RegExp(
        `^'main' goes back to ${git('rev-parse', '--short', start)} as before the cherry pick, dropping the 1 commit it has made so far\\.`,
      ),
    );
    assert.equal(git('rev-parse', 'HEAD'), start);
  });

  it('names where a rebase started even when ORIG_HEAD moved while it was stopped', async () => {
    branchWith('strata-topic', 'main~1', 'main.txt', 'topic\n');
    const tip = git('rev-parse', 'HEAD');
    ui.press('Rebase');
    await run('strata.rebase', branchMenu('main', git('rev-parse', 'main')));
    git('update-ref', 'ORIG_HEAD', 'main~1');
    ui.clear();
    ui.press('Abort Rebase');
    await run('strata.operation.abort');
    assert.match(
      ui.first('confirm').detail,
      new RegExp(`^'strata-topic' goes back to ${git('rev-parse', '--short', tip)} as before the rebase\\.`),
    );
    assert.equal(git('rev-parse', 'HEAD'), tip);
  });

  it('continues a rebase once its conflict is resolved, not before, and the banner goes', async () => {
    branchWith('strata-topic', 'main~1', 'main.txt', 'topic\n');
    ui.press('Rebase');
    await run('strata.rebase', branchMenu('main', git('rev-parse', 'main')));
    await waitFor('rebase banner', async () => (await panel().probe()).banner?.state === 'rebase');

    ui.clear();
    await run('strata.operation.continue');
    assert.equal(ui.first('confirm').message, '1 file still has conflicts: main.txt.');
    assert.equal(api().contextValue('strata.operation'), 'rebase');

    write('main.txt', 'resolved\n');
    git('add', 'main.txt');
    await run('strata.operation.continue');
    assert.equal(git('rev-parse', 'HEAD~1'), git('rev-parse', 'main'));
    assert.equal(git('show', 'HEAD:main.txt'), 'resolved');
    assert.equal(api().contextValue('strata.operation'), '');
    await waitFor('no banner', async () => (await panel().probe()).banner === undefined);
  });

  it('undoes a rebase that stopped and then finished with Continue, back to where it started', async () => {
    branchWith('strata-topic', 'main~1', 'main.txt', 'topic\n');
    const tip = git('rev-parse', 'HEAD');
    ui.press('Rebase');
    await run('strata.rebase', branchMenu('main', git('rev-parse', 'main')));
    write('main.txt', 'resolved\n');
    git('add', 'main.txt');
    ui.clear();
    await run('strata.operation.continue');
    assert.deepEqual(ui.of('notify').at(-1), {
      kind: 'notify',
      level: 'info',
      message: 'Finished the rebase',
      actions: ['Undo'],
    });
    assert.equal(api().contextValue('strata.canUndo'), true);
    await run('strata.undo');
    assert.equal(git('branch', '--show-current'), 'strata-topic');
    assert.equal(git('rev-parse', 'HEAD'), tip);
  });

  it('reports a Continue that stops at the next edit as a stop, then finishes with the next Continue', async () => {
    git('switch', '--quiet', '--create', 'strata-topic', 'main');
    const [a, b, c] = [commitFile('a.txt', 'a\n'), commitFile('b.txt', 'b\n'), commitFile('c.txt', 'c\n')];
    rebaseInteractive('main', [`edit ${a}`, `edit ${b}`, `pick ${c}`]);
    await reload(panel());
    assert.equal(api().contextValue('strata.operation'), 'rebase');

    ui.clear();
    await run('strata.operation.continue');
    assert.deepEqual(ui.of('notify').at(-1), {
      kind: 'notify',
      level: 'warning',
      message: 'Rebase stopped at 2 of 3 ("b.txt: b"): Continue replays the remaining 1 commit.',
      actions: ['Continue', 'Abort Rebase...'],
    });
    assert.equal(api().contextValue('strata.operation'), 'rebase');

    ui.clear();
    await run('strata.operation.continue');
    assert.equal(ui.of('notify').at(-1)?.message, 'Finished the rebase');
    assert.equal(api().contextValue('strata.operation'), '');
    assert.equal(git('rev-parse', 'HEAD'), c);
  });

  it('undoes a rebase that stopped and then finished with Skip, back to where it started', async () => {
    branchWith('strata-topic', 'main~1', 'main.txt', 'topic\n');
    const tip = git('rev-parse', 'HEAD');
    ui.press('Rebase');
    await run('strata.rebase', branchMenu('main', git('rev-parse', 'main')));
    assert.equal(api().contextValue('strata.operation'), 'rebase');
    ui.press('Skip Commit');
    await run('strata.operation.skip');
    assert.equal(api().contextValue('strata.operation'), '');
    assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', 'main'));
    assert.equal(api().contextValue('strata.canUndo'), true);
    await run('strata.undo');
    assert.equal(git('branch', '--show-current'), 'strata-topic');
    assert.equal(git('rev-parse', 'HEAD'), tip);
  });

  it('undoes a merge and a cherry pick that stopped and then finished with Continue', async () => {
    const before = git('rev-parse', 'HEAD');
    const picked = await conflicting();
    await run('strata.cherryPick', commitMenu(picked));
    write('main.txt', 'resolved\n');
    git('add', 'main.txt');
    await run('strata.operation.continue');
    assert.equal(git('log', '-1', '--format=%s'), 'main.txt: picked');
    await run('strata.undo');
    assert.equal(git('rev-parse', 'HEAD'), before);

    ui.press('Merge');
    await run('strata.merge', branchMenu('strata-pick', picked));
    assert.equal(api().contextValue('strata.operation'), 'merge');
    write('main.txt', 'resolved\n');
    git('add', 'main.txt');
    await run('strata.operation.continue');
    assert.equal(git('rev-parse', 'HEAD^2'), picked);
    await run('strata.undo');
    assert.equal(git('rev-parse', 'HEAD'), before);
    assert.equal(git('status', '--porcelain', '--untracked-files=no'), '');
  });

  it('aborts a rebase that stopped, and git gives back the changes it stashed', async () => {
    branchWith('strata-topic', 'main~1', 'main.txt', 'topic\n');
    const tip = git('rev-parse', 'HEAD');
    write('NOTES.md', 'mine\n');
    ui.press('Stash & Rebase');
    await run('strata.rebase', branchMenu('main', git('rev-parse', 'main')));
    assert.equal(api().contextValue('strata.operation'), 'rebase');
    ui.clear();
    ui.press('Abort Rebase');
    await run('strata.operation.abort');
    assert.match(ui.first('confirm').detail, /Your stashed changes are restored\.$/);
    assert.equal(git('rev-parse', 'HEAD'), tip);
    assert.equal(read('NOTES.md'), 'mine\n');
    assert.equal(git('stash', 'list'), '');
  });

  it('concludes a merge that stopped with Continue, without conflict notes, and git gives the changes back', async () => {
    branchWith('strata-topic', 'main~1', 'main.txt', 'topic\n');
    git('switch', '--quiet', 'main');
    await reload(panel());
    write('NOTES.md', 'mine\n');
    ui.press('Stash & Merge');
    await run('strata.merge', branchMenu('strata-topic', git('rev-parse', 'strata-topic')));
    assert.equal(api().contextValue('strata.operation'), 'merge');
    write('main.txt', 'resolved\n');
    git('add', 'main.txt');
    await run('strata.operation.continue');
    assert.equal(git('rev-parse', 'HEAD^2'), git('rev-parse', 'strata-topic'));
    assert.equal(git('log', '-1', '--format=%B'), "Merge branch 'strata-topic'");
    assert.equal(read('NOTES.md'), 'mine\n');
    assert.equal(api().contextValue('strata.operation'), '');
  });

  it("says git's autostash is still in the stash when Continue could not restore it over changes made since", async () => {
    branchWith('strata-topic', 'main~1', 'main.txt', 'topic\n');
    git('switch', '--quiet', 'main');
    await reload(panel());
    write('NOTES.md', 'mine\n');
    ui.press('Stash & Merge');
    await run('strata.merge', branchMenu('strata-topic', git('rev-parse', 'strata-topic')));
    assert.equal(api().contextValue('strata.operation'), 'merge');
    write('NOTES.md', 'edited while resolving\n');
    write('main.txt', 'resolved\n');
    git('add', 'main.txt');
    ui.clear();
    await run('strata.operation.continue');
    assert.equal(git('rev-parse', 'HEAD^2'), git('rev-parse', 'strata-topic'));
    assert.equal(read('NOTES.md'), 'edited while resolving\n', 'nothing was restored');
    const stash = git('rev-parse', 'refs/stash');
    assert.equal(git('show', `${stash}:NOTES.md`), 'mine');
    assert.equal(
      ui.of('notify').find((n) => n.level === 'warning')?.message,
      'Finished the merge, but git could not restore your stashed changes: they would overwrite your changes to NOTES.md. They\'re safe in stash@{0} ("autostash").',
    );
    await reload(panel());
    assert.equal(await leftover(), undefined, 'not a resolved restore conflict whose stash could be dropped');
  });

  it('skips a cherry pick that stopped, and gives back the changes stashed for it', async () => {
    const picked = await conflicting();
    const before = git('rev-parse', 'HEAD');
    write('NOTES.md', 'mine\n');
    ui.press('Stash & Cherry Pick');
    await run('strata.cherryPick', commitMenu(picked));
    assert.equal(api().contextValue('strata.operation'), 'cherryPick');
    ui.press('Skip Commit');
    await run('strata.operation.skip');
    assert.match(ui.of('confirm').at(-1)?.message ?? '', /^Skip [0-9a-f]+ "main\.txt: picked"\?$/);
    assert.equal(git('rev-parse', 'HEAD'), before);
    assert.equal(read('NOTES.md'), 'mine\n');
    assert.equal(git('stash', 'list'), '');
    assert.equal(api().contextValue('strata.operation'), '');
  });

  it("pops none of the user's own stashes when the changes to stash were gone by then", async () => {
    const notes = read('NOTES.md');
    write('NOTES.md', 'theirs\n');
    git('stash', 'push', '--quiet', '--message', 'theirs');
    const theirs = git('rev-parse', 'refs/stash');
    write('NOTES.md', 'mine\n');
    ui.press('Stash & Cherry Pick').meanwhile(() => git('checkout', '--', 'NOTES.md'));
    await run('strata.cherryPick', commitMenu(git('rev-parse', 'wip/experiment')));
    assert.equal(git('log', '-1', '--format=%s'), 'Unmerged experiment');
    assert.equal(git('rev-parse', 'refs/stash'), theirs);
    assert.equal(read('NOTES.md'), notes);
  });

  it("says when git's autostash conflicts on restore, and remembers the stash", async () => {
    branchWith('strata-topic', 'main~1', 'topic.txt', 'topic\n');
    write('main.txt', 'dirty\n');
    ui.press('Stash & Rebase');
    await run('strata.rebase', branchMenu('main', git('rev-parse', 'main')));
    assert.deepEqual(ui.first('confirm').buttons, ['Stash & Rebase']);
    assert.equal(git('rev-parse', 'HEAD~1'), git('rev-parse', 'main'), 'rebased');
    const warning = ui.of('notify').find((n) => n.level === 'warning');
    assert.match(
      warning?.message ?? '',
      /^Rebased 'strata-topic' onto 'main' \(1 commit\), but restoring your stashed changes conflicted in 1 file \(main\.txt\)\. Your changes are safe in stash@\{0\} \("autostash"\)\.$/,
    );
    const stash = git('rev-parse', 'refs/stash');
    await waitFor('leftover reported', async () => {
      const l = (await panel().probe()).leftover;
      return l?.kind === 'restoreConflicted' && l.stash.hash === stash;
    });
  });

  it('cherry picks onto uncommitted changes through its own stash, and gives them back', async () => {
    const picked = git('rev-parse', 'wip/experiment');
    write('NOTES.md', 'mine\n');
    ui.press('Stash & Cherry Pick');
    await run('strata.cherryPick', commitMenu(picked));
    assert.deepEqual(ui.first('confirm').buttons, ['Cherry Pick Keeping Changes', 'Stash & Cherry Pick']);
    assert.equal(git('log', '-1', '--format=%s'), 'Unmerged experiment');
    assert.equal(readFileSync(join(workspaceRoot(), 'NOTES.md'), 'utf8'), 'mine\n');
    assert.equal(git('stash', 'list'), '');
  });

  it('restores the stash of a cherry pick that stopped once Continue finishes it', async () => {
    const picked = await conflicting();
    const notes = read('NOTES.md');
    write('NOTES.md', 'mine\n');
    ui.press('Stash & Cherry Pick');
    await run('strata.cherryPick', commitMenu(picked));
    assert.match(
      ui.of('notify').at(-1)?.message ?? '',
      /Your uncommitted changes are in stash@\{0\} \("On main: Strata autostash: cherry pick [0-9a-f]+ onto 'main'"\)\.$/,
    );
    await waitFor('the banner names the held stash', async () =>
      (await panel().probe()).banner?.text.includes('Your uncommitted changes are in stash@{0} (Strata autostash)'),
    );
    assert.equal(read('NOTES.md'), notes);
    write('main.txt', 'resolved\n');
    git('add', 'main.txt');
    await run('strata.operation.continue');
    assert.equal(git('log', '-1', '--format=%s'), 'main.txt: picked');
    assert.equal(read('NOTES.md'), 'mine\n');
    assert.equal(git('stash', 'list'), '');
  });

  it('never restores a Strata stash the stopped cherry pick did not push', async () => {
    const picked = await conflicting();
    const notes = read('NOTES.md');
    write('NOTES.md', 'mine\n');
    ui.press('Stash & Cherry Pick');
    await run('strata.cherryPick', commitMenu(picked));
    const kept = git('rev-parse', 'refs/stash');
    git('cherry-pick', '--abort');
    await waitFor('the stash is pending', async () => (await leftover())?.kind === 'pendingStash');
    await run('strata.keepStash', menu({ strataHash: kept }));
    await waitFor('the stash is kept', async () => (await leftover()) === undefined);

    ui.clear();
    await run('strata.cherryPick', commitMenu(picked));
    assert.doesNotMatch(ui.of('notify').at(-1)?.message ?? '', /stash/);
    write('main.txt', 'resolved\n');
    git('add', 'main.txt');
    await run('strata.operation.continue');
    assert.equal(git('log', '-1', '--format=%s'), 'main.txt: picked');
    assert.equal(git('rev-parse', 'refs/stash'), kept);
    assert.equal(read('NOTES.md'), notes);
  });

  it('leaves a Strata stash of another worktree alone: no banner here, and no restore on Abort', async () => {
    const picked = await conflicting();
    const other = join(mkdtempSync(join(tmpdir(), 'strata-wt-')), 'other');
    git('worktree', 'add', '--quiet', '--detach', other, 'main');
    try {
      writeFileSync(join(other, 'NOTES.md'), 'theirs\n');
      const short = git('rev-parse', '--short', picked);
      execFileSync(
        'git',
        ['stash', 'push', '--quiet', '--message', `Strata autostash: cherry pick ${short} onto HEAD`],
        {
          cwd: other,
        },
      );
      const theirs = git('rev-parse', 'refs/stash');
      await reload(panel());
      assert.equal(await leftover(), undefined);

      const notes = read('NOTES.md');
      await run('strata.cherryPick', commitMenu(picked));
      assert.doesNotMatch(ui.of('notify').at(-1)?.message ?? '', /stash/);
      ui.press('Abort Cherry Pick');
      await run('strata.operation.abort');
      assert.doesNotMatch(ui.first('confirm').detail, /stashed changes/);
      assert.equal(git('rev-parse', 'refs/stash'), theirs);
      assert.equal(read('NOTES.md'), notes);
    } finally {
      git('worktree', 'remove', '--force', other);
      rmSync(join(other, '..'), { recursive: true, force: true });
    }
  });

  it('stops at a cherry pick whose changes are already there, keeps its stash, and skips it', async () => {
    const picked = git('rev-parse', 'wip/experiment');
    git('cherry-pick', picked);
    const notes = read('NOTES.md');
    write('NOTES.md', 'mine\n');
    ui.press('Stash & Cherry Pick');
    await run('strata.cherryPick', commitMenu(picked));
    const stop = ui.of('notify').at(-1);
    assert.equal(stop?.level, 'warning');
    assert.match(stop.message, /^Cherry pick stopped \("Unmerged experiment"\): The previous cherry-pick is now empty/);
    assert.match(stop.message, /Your uncommitted changes are in stash@\{0\}/);
    assert.deepEqual(stop.actions, ['Skip...', 'Abort Cherry Pick...']);
    assert.equal(read('NOTES.md'), notes, 'not popped into the stopped cherry pick');

    ui.press('Skip Commit');
    await run('strata.operation.skip');
    assert.equal(api().contextValue('strata.operation'), '');
    assert.equal(read('NOTES.md'), 'mine\n');
    assert.equal(git('stash', 'list'), '');
  });

  /** strata-new from main: one commit adding new.txt; HEAD back on main, new.txt untracked there. */
  const inTheWay = async () => {
    branchWith('strata-new', 'main', 'new.txt', 'theirs\n');
    git('switch', '--quiet', 'main');
    write('new.txt', 'mine\n');
    await reload(panel());
    return git('rev-parse', 'strata-new');
  };
  const onlyStash = (op: string) => {
    assert.equal(git('stash', 'list', '--format=%gs'), `On main: Strata: untracked files in the way of ${op}`);
  };
  const noTrouble = () => {
    assert.deepEqual(
      ui.of('notify').filter((n) => n.level !== 'info'),
      [],
    );
  };

  it("merges after moving untracked files out of its way, with git's autostash both times", async () => {
    const tip = await inTheWay();
    write('NOTES.md', 'dirty\n');
    ui.press('Stash & Merge', 'Stash It & Retry');
    await run('strata.merge', branchMenu('strata-new', tip));
    assert.equal(ui.of('confirm')[1]?.message, "1 untracked file is in the way of the merge of 'strata-new': new.txt.");
    assert.equal(git('rev-parse', 'HEAD'), tip, 'fast-forwarded');
    assert.equal(read('new.txt'), 'theirs\n');
    assert.equal(read('NOTES.md'), 'dirty\n');
    onlyStash("merge of 'strata-new'");
    assert.equal(git('show', 'stash@{0}^3:new.txt'), 'mine');
    noTrouble();
  });

  it('rebases after moving untracked files out of its way', async () => {
    const onto = await inTheWay();
    branchWith('strata-topic', 'main~1', 'topic.txt', 'topic\n');
    await reload(panel());
    ui.press('Rebase', 'Stash It & Retry');
    await run('strata.rebase', branchMenu('strata-new', onto));
    assert.equal(
      ui.of('confirm')[1]?.message,
      "1 untracked file is in the way of the rebase onto 'strata-new': new.txt.",
    );
    assert.equal(git('rev-parse', 'HEAD~1'), onto);
    assert.equal(read('new.txt'), 'theirs\n');
    assert.equal(
      git('stash', 'list', '--format=%gs'),
      "On strata-topic: Strata: untracked files in the way of rebase onto 'strata-new'",
    );
    noTrouble();
  });

  it('cherry picks after moving untracked files out of its way, stashing around it again', async () => {
    const picked = await inTheWay();
    const short = git('rev-parse', '--short', picked);
    write('NOTES.md', 'mine\n');
    ui.press('Stash & Cherry Pick', 'Stash It & Retry');
    await run('strata.cherryPick', commitMenu(picked));
    assert.equal(
      ui.of('confirm')[1]?.message,
      `1 untracked file is in the way of the cherry pick of ${short}: new.txt.`,
    );
    assert.equal(git('log', '-1', '--format=%s'), 'new.txt: theirs');
    assert.equal(read('new.txt'), 'theirs\n');
    assert.equal(read('NOTES.md'), 'mine\n', 'the stashed change came back');
    onlyStash(`cherry pick of ${short}`);
    noTrouble();
    assert.equal(await leftover(), undefined);
  });

  it('reverts after moving untracked files out of its way', async () => {
    git('rm', '--quiet', 'NOTES.md');
    git('commit', '--quiet', '-m', 'Drop notes');
    const dropped = git('rev-parse', 'HEAD');
    const notes = git('show', 'HEAD~1:NOTES.md');
    write('NOTES.md', 'mine\n');
    await reload(panel());
    const short = git('rev-parse', '--short', dropped);
    ui.press('Stash It & Retry');
    await run('strata.revert', commitMenu(dropped));
    assert.equal(ui.of('confirm')[0]?.message, `1 untracked file is in the way of the revert of ${short}: NOTES.md.`);
    assert.equal(git('log', '-1', '--format=%s'), 'Revert "Drop notes"');
    assert.equal(git('show', 'HEAD:NOTES.md'), notes);
    onlyStash(`revert of ${short}`);
    noTrouble();
  });

  /**
   * Makes the workspace a shallow clone whose oldest commits are `edges`, of an origin that has
   * the whole history.
   */
  const shallow = (...edges: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'strata-origin-'));
    origins.push(dir);
    execFileSync('git', ['init', '--quiet', '--bare', dir]);
    git('remote', 'add', 'origin', dir);
    git('push', '--quiet', 'origin', 'refs/heads/*:refs/heads/*');
    writeFileSync(join(workspaceRoot(), '.git', 'shallow'), edges.map((e) => `${e}\n`).join(''));
  };
  const origins: string[] = [];
  afterEach(() => {
    for (const dir of origins.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  /** strata-deep: `n` empty commits on main, with HEAD on it. */
  const deep = (n: number) => {
    const main = git('rev-parse', 'main');
    const stream = Array.from({ length: n }, (_, i) => {
      const message = `Deep ${i}`;
      const from = i === 0 ? `from ${main}\n` : '';
      return `commit refs/heads/strata-deep\ncommitter Ada Lovelace <ada@example.com> ${1_700_010_000 + i * 60} +0000\ndata ${message.length}\n${message}\n${from}\n`;
    }).join('');
    execFileSync('git', ['fast-import', '--quiet'], { cwd: workspaceRoot(), input: stream });
    git('switch', '--quiet', 'strata-deep');
    return git('rev-parse', 'HEAD');
  };

  it('fetches 100 more commits of a shallow clone, or all of them, when two lines meet beyond its edge', async () => {
    branchWith('strata-topic', 'main', 'topic.txt', 'topic\n');
    const topic = git('rev-parse', 'HEAD');
    const tip = deep(150);
    shallow(tip, topic);
    await reload(panel());
    ui.press('Fetch More History');
    await run('strata.merge', branchMenu('strata-topic', topic));
    assert.deepEqual(ui.of('confirm'), [
      {
        kind: 'confirm',
        message: "This clone is shallow: 'strata-deep' and 'strata-topic' have no common commit in it.",
        detail:
          'Fetch More History goes 100 commits further back; Fetch Full History fetches the whole history. Then try again.',
        buttons: ['Fetch More History', 'Fetch Full History'],
      },
    ]);
    assert.equal(git('rev-parse', '--is-shallow-repository'), 'true');
    assert.equal(git('rev-list', '--count', 'HEAD'), '101');

    ui.clear();
    ui.press('Fetch Full History');
    await run('strata.merge', branchMenu('strata-topic', topic));
    assert.equal(git('rev-parse', '--is-shallow-repository'), 'false');
    assert.equal(git('rev-parse', 'HEAD'), tip, 'the merge waits to be tried again');
    assert.deepEqual(
      ui.of('notify').filter((n) => n.level !== 'info'),
      [],
    );
  });

  it("refuses to cherry pick, revert or copy the patch of a shallow clone's oldest commit, and fetches more", async () => {
    const picked = git('rev-parse', 'wip/experiment');
    const main = git('rev-parse', 'main');
    shallow(picked, main);
    await reload(panel());
    const refused = (rev: string) => [
      `${git('rev-parse', '--short', rev)} is the oldest commit this shallow clone has; its parent is not here, so its changes cannot be told apart from the whole tree.`,
      ['Fetch More History', 'Fetch Full History'],
    ];
    await run('strata.cherryPick', commitMenu(picked));
    await run('strata.revert', commitMenu(main));
    await vscode.env.clipboard.writeText('untouched');
    await run('strata.commit.copyPatch', commitMenu(main));
    assert.deepEqual(
      ui.of('confirm').map((q) => [q.message, q.buttons]),
      [refused(picked), refused(main), refused(main)],
    );
    assert.equal(git('rev-parse', 'HEAD'), main, 'nothing picked or reverted');
    assert.equal(await vscode.env.clipboard.readText(), 'untouched');

    ui.clear();
    ui.press('Fetch More History');
    await run('strata.cherryPick', commitMenu(picked));
    assert.equal(git('rev-parse', '--is-shallow-repository'), 'false', 'the fixture is not 100 commits deep');
    assert.equal(git('rev-parse', 'HEAD'), main, 'the cherry pick waits to be tried again');
    await run('strata.cherryPick', commitMenu(picked));
    assert.equal(git('log', '-1', '--format=%s'), 'Unmerged experiment');
  });

  it("refuses to copy the patch of a file in a shallow clone's oldest commit, but not against another commit", async () => {
    const main = git('rev-parse', 'main');
    const [path] = git('diff-tree', '--no-commit-id', '--name-only', '-r', main).split('\n');
    assert.ok(path, 'main changes a file');
    const parent = git('rev-parse', 'main^');
    shallow(main);
    await reload(panel());
    const fileMenu = (base?: string) =>
      menu({
        strataHash: main,
        strataPath: path,
        strataStatus: 'M',
        ...(base === undefined ? {} : { strataBase: base }),
      });
    await vscode.env.clipboard.writeText('untouched');
    await run('strata.file.copyPatch', fileMenu());
    assert.deepEqual(
      ui.of('confirm').map((q) => [q.message, q.buttons]),
      [
        [
          `${git('rev-parse', '--short', main)} is the oldest commit this shallow clone has; its parent is not here, so its changes to ${path} cannot be told apart from the whole file.`,
          ['Fetch More History', 'Fetch Full History'],
        ],
      ],
    );
    assert.equal(await vscode.env.clipboard.readText(), 'untouched');

    ui.clear();
    await run('strata.file.copyPatch', fileMenu(parent));
    assert.deepEqual(ui.of('confirm'), []);
    const patch = await vscode.env.clipboard.readText();
    assert.match(patch, new RegExp(`^diff --git a/${path} b/${path}$`, 'm'));
    assert.doesNotMatch(patch, /^new file mode/m, 'against a commit the clone has');
  });

  it('says when a merge finds no common commit, before asking to merge', async () => {
    const orphan = git('commit-tree', 'HEAD^{tree}', '-m', 'Orphan');
    git('branch', 'strata-orphan', orphan);
    await reload(panel());
    await run('strata.merge', branchMenu('strata-orphan', orphan));
    assert.deepEqual(ui.asked, [
      { kind: 'notify', level: 'error', message: 'These histories have no commit in common here.', actions: [] },
    ]);
  });

  /** strata-ahead: one commit on main; HEAD on main. */
  const ahead = async () => {
    branchWith('strata-ahead', 'main', 'ahead.txt', 'ahead\n');
    git('switch', '--quiet', 'main');
    await reload(panel());
    return git('rev-parse', 'strata-ahead');
  };

  it('says when git finds no common commit to merge after all', async () => {
    const tip = await ahead();
    const main = git('rev-parse', 'main');
    // Seen through a replacement without parents, strata-ahead's history no longer reaches main.
    ui.press('Fast-Forward').meanwhile(() => git('replace', '--graft', tip));
    await run('strata.merge', branchMenu('strata-ahead', tip));
    assert.deepEqual(ui.of('notify'), [
      { kind: 'notify', level: 'error', message: 'These histories have no commit in common here.', actions: [] },
    ]);
    assert.equal(git('rev-parse', 'main'), main);
  });

  it('offers to fetch history when git finds no common commit to merge in a shallow clone', async () => {
    const tip = await ahead();
    ui.press('Fast-Forward', 'Fetch Full History').meanwhile(() => {
      shallow(tip, git('rev-parse', 'main'));
    });
    await run('strata.merge', branchMenu('strata-ahead', tip));
    assert.deepEqual(
      ui.of('confirm').map((q) => [q.message, q.buttons]),
      [
        ["Merge 'strata-ahead' into 'main'?", ['Fast-Forward', 'Create Merge Commit']],
        [
          "This clone is shallow: 'main' and 'strata-ahead' have no common commit in it.",
          ['Fetch More History', 'Fetch Full History'],
        ],
      ],
    );
    assert.equal(git('rev-parse', '--is-shallow-repository'), 'false');
    assert.deepEqual(
      ui.of('notify').filter((n) => n.level !== 'info'),
      [],
    );
  });

  it('reverts a commit, and undoes that', async () => {
    const before = git('rev-parse', 'main');
    const subject = git('log', '-1', '--format=%s', 'main');
    await run('strata.revert', commitMenu(before));
    assert.equal(git('log', '-1', '--format=%s'), `Revert "${subject}"`);
    assert.equal(git('rev-parse', 'HEAD^{tree}'), git('rev-parse', 'HEAD~2^{tree}'));
    await run('strata.undo');
    assert.equal(git('rev-parse', 'main'), before);
  });

  /** strata-side from main: side.txt in two commits, merged into main after a commit of main's own. HEAD on main. */
  const mergedSide = async () => {
    const fork = git('rev-parse', 'main');
    branchWith('strata-side', 'main', 'side.txt', 'side 1\n');
    write('side.txt', 'side 2\n');
    git('commit', '--quiet', '-am', 'side.txt: side 2');
    git('switch', '--quiet', 'main');
    write('mainline.txt', 'mainline\n');
    git('add', 'mainline.txt');
    git('commit', '--quiet', '-m', 'Mainline');
    git('merge', '--quiet', '--no-ff', '--no-edit', 'strata-side');
    await reload(panel());
    return { merge: git('rev-parse', 'HEAD'), fork };
  };
  const short = (rev: string) => git('rev-parse', '--short', rev);

  it('reverts a merge, naming the commits it undoes, and undoes that', async () => {
    const { merge } = await mergedSide();
    ui.press('Revert');
    await run('strata.revert', commitMenu(merge));
    assert.deepEqual(
      ui.of('confirm').map((q) => [q.message, q.detail, q.buttons]),
      [
        [
          `Revert ${short(merge)} "Merge branch 'strata-side'" on 'main'?`,
          `Undoes the changes of the 2 commits it merged into ${short(`${merge}^1`)} "Mainline" from ${short(`${merge}^2`)} "side.txt: side 2". Merging those commits again later won't bring them back.`,
          ['Revert'],
        ],
      ],
    );
    assert.equal(git('log', '-1', '--format=%s'), `Revert "Merge branch 'strata-side'"`);
    assert.equal(git('rev-parse', 'HEAD^{tree}'), git('rev-parse', `${merge}^1^{tree}`));
    await run('strata.undo');
    assert.equal(git('rev-parse', 'main'), merge);
  });

  it('cherry picks a merge relative to the parent chosen, through its own stash', async () => {
    const { merge, fork } = await mergedSide();
    git('switch', '--quiet', '--create', 'strata-target', fork);
    write('NOTES.md', 'mine\n');
    await reload(panel());
    ui.choose(/^Parent 2:/).press('Stash & Cherry Pick');
    await run('strata.cherryPick', commitMenu(merge));
    assert.deepEqual(ui.first('pick'), {
      kind: 'pick',
      title: `Cherry Pick ${short(merge)} "Merge branch 'strata-side'"`,
      items: [`Parent 1: ${short(`${merge}^1`)}`, `Parent 2: ${short(`${merge}^2`)}`],
    });
    assert.match(
      ui.first('confirm').detail,
      new RegExp(
        `^Applies the changes of the 1 commit it merged into ${short(`${merge}^2`)} "side\\.txt: side 2" from ${short(`${merge}^1`)} "Mainline"\\. `,
      ),
    );
    assert.equal(git('log', '-1', '--format=%s'), "Merge branch 'strata-side'");
    assert.equal(git('diff', '--name-only', 'HEAD~1', 'HEAD'), 'mainline.txt');
    assert.equal(read('NOTES.md'), 'mine\n');
    assert.equal(git('stash', 'list'), '');
  });

  it('stops a cherry pick of a merge at its conflict, and Continue finishes it', async () => {
    const { merge, fork } = await mergedSide();
    branchWith('strata-target', fork, 'side.txt', 'target\n');
    await reload(panel());
    ui.choose(/^Parent 1:/);
    await run('strata.cherryPick', commitMenu(merge));
    assert.equal(ui.of('confirm').length, 0, 'the parent was the question');
    assert.equal(
      ui.of('notify').at(-1)?.message,
      `Cherry pick stopped ("Merge branch 'strata-side'") with conflicts in 1 file (side.txt).`,
    );
    write('side.txt', 'resolved\n');
    git('add', 'side.txt');
    await run('strata.operation.continue');
    assert.equal(api().contextValue('strata.operation'), '');
    assert.equal(git('log', '-1', '--format=%s'), "Merge branch 'strata-side'");
    assert.equal(git('rev-list', '--parents', '-n1', 'HEAD').split(' ').length, 2, 'one parent');
    assert.equal(read('side.txt'), 'resolved\n');
  });

  it("says a branch already has a merge, and refuses one at a shallow clone's edge", async () => {
    const { merge } = await mergedSide();
    git('switch', '--quiet', '--create', 'strata-later', 'main');
    await run('strata.cherryPick', commitMenu(merge));
    assert.equal(ui.of('pick').length, 0);
    assert.equal(ui.of('notify').at(-1)?.message, `'strata-later' already contains ${short(merge)}.`);

    shallow(merge);
    await reload(panel());
    await run('strata.revert', commitMenu(merge));
    assert.match(
      ui.first('confirm').message,
      new RegExp(`^${short(merge)} is the oldest commit this shallow clone has`),
    );
    assert.equal(git('rev-parse', 'HEAD'), merge, 'nothing reverted');
  });

  it('says a commit or a merge is already reverted, and gives back the changes stashed for it', async () => {
    const main = git('rev-parse', 'main');
    git('revert', '--no-edit', main);
    const reverted = git('rev-parse', 'HEAD');
    await reload(panel());
    await run('strata.revert', commitMenu(main));
    assert.deepEqual(ui.of('notify').at(-1), {
      kind: 'notify',
      level: 'info',
      message: `${short(main)} is already reverted on 'main': there is nothing to undo.`,
      actions: [],
    });
    assert.equal(git('rev-parse', 'HEAD'), reverted);

    ui.clear();
    const { merge } = await mergedSide();
    git('revert', '--no-edit', '-m', '1', merge);
    const again = git('rev-parse', 'HEAD');
    write('NOTES.md', 'mine\n');
    ui.press('Stash & Revert');
    await run('strata.revert', commitMenu(merge));
    assert.equal(
      ui.of('notify').at(-1)?.message,
      `${short(merge)} is already reverted on 'main': there is nothing to undo.`,
    );
    assert.equal(git('rev-parse', 'HEAD'), again);
    assert.equal(read('NOTES.md'), 'mine\n');
    assert.equal(git('stash', 'list'), '');
    assert.equal(api().contextValue('strata.operation'), '');
  });

  it('keeps uncommitted changes of a hard reset in a stash it never pops, and undoes the reset', async () => {
    const before = git('rev-parse', 'main');
    const target = git('rev-parse', 'main~2');
    write('main.txt', 'dirty\n');
    ui.choose('Hard').press('Stash Changes & Reset');
    await run('strata.reset', commitMenu(target));
    const asked = ui.first('confirm');
    assert.deepEqual(asked.buttons, ['Stash Changes & Reset', 'Discard Changes & Reset']);
    assert.match(
      asked.detail,
      /Stash Changes & Reset keeps them in the stash list; Discard Changes & Reset throws them away\./,
    );
    assert.equal(git('rev-parse', 'HEAD'), target);
    assert.equal(git('status', '--porcelain', '--untracked-files=no'), '');
    const short = git('rev-parse', '--short', target);
    assert.equal(git('stash', 'list', '--format=%gs'), `On main: Strata: before reset of main to ${short}`);
    await run('strata.undo');
    assert.equal(git('rev-parse', 'HEAD'), before);
  });

  /** strata-reset, with HEAD on it: its tip untracks `file` (and ignores it), which its parent, returned, tracks. */
  const untrackedAtTip = async (file: string, ignore: boolean) => {
    branchWith('strata-reset', 'main', file, 'committed\n');
    const target = git('rev-parse', 'HEAD');
    git('rm', '--quiet', '--cached', file);
    if (ignore) {
      write('.gitignore', `${file}\n`);
      git('add', '.gitignore');
    }
    git('commit', '--quiet', '-m', `Untrack ${file}`);
    await reload(panel());
    return target;
  };

  it('stashes an ignored file a hard reset would overwrite, along with the changes', async () => {
    const target = await untrackedAtTip('local.cfg', true);
    write('local.cfg', 'mine\n');
    write('main.txt', 'dirty\n');
    ui.choose('Hard').press('Stash Changes & Reset');
    await run('strata.reset', commitMenu(target));
    assert.deepEqual(
      ui.of('notify').filter((n) => n.level === 'error'),
      [],
    );
    assert.equal(git('rev-parse', 'HEAD'), target);
    assert.equal(git('show', 'stash@{0}^3:local.cfg'), 'mine');
    assert.equal(git('show', 'stash@{0}:main.txt'), 'dirty');
  });

  it('stashes before a hard reset over a staged deletion', async () => {
    const target = await untrackedAtTip('new.txt', false);
    write('new.txt', 'mine\n');
    git('rm', '--quiet', 'main.txt');
    ui.choose('Hard').press('Stash Changes & Reset');
    await run('strata.reset', commitMenu(target));
    assert.deepEqual(
      ui.of('notify').filter((n) => n.level === 'error'),
      [],
    );
    assert.equal(git('rev-parse', 'HEAD'), target);
    assert.equal(git('show', 'stash@{0}^3:new.txt'), 'mine');
  });

  it('undoes a mixed reset with a mixed reset, which keep could not', async () => {
    const before = git('rev-parse', 'main');
    ui.choose('Mixed').press("Reset 'main'");
    await run('strata.reset', commitMenu(git('rev-parse', 'main~1')));
    assert.notEqual(git('status', '--porcelain', '--untracked-files=no'), '', 'the commit is now in the files');
    await run('strata.undo');
    assert.equal(git('rev-parse', 'HEAD'), before);
    assert.equal(git('status', '--porcelain', '--untracked-files=no'), '');
    assert.equal(ui.of('notify').filter((n) => n.level === 'error').length, 0);
  });
});
