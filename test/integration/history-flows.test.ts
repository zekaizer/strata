import * as assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { branchMenu, commitMenu, flowSuite, reload, run, selected } from './flow-helpers.ts';
import { git, waitFor, workspaceRoot } from './helpers.ts';

const write = (file: string, content: string) => {
  writeFileSync(join(workspaceRoot(), file), content);
};
/** A branch from `from` with one commit writing `file`. */
const branchWith = (branch: string, from: string, file: string, content: string) => {
  git('switch', '--quiet', '--create', branch, from);
  write(file, content);
  git('add', file);
  git('commit', '--quiet', '-m', `${file}: ${content.trim()}`);
};

describe('history operations', () => {
  const { api, panel, ui } = flowSuite();

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

  it('records a merge commit when asked to', async () => {
    branchWith('strata-ahead', 'main', 'ahead.txt', 'ahead\n');
    git('switch', '--quiet', 'main');
    await reload(panel());
    ui.press('Create Merge Commit');
    await run('strata.merge', branchMenu('strata-ahead', git('rev-parse', 'strata-ahead')));
    assert.equal(git('rev-list', '--parents', '-n1', 'HEAD').split(' ').length, 3);
    assert.equal(git('log', '-1', '--format=%s'), "Merge branch 'strata-ahead'");
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
