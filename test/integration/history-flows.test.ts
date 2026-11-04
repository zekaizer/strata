import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
