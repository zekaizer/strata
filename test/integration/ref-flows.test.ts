import * as assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { branchMenu, commitMenu, flowSuite, run, selected, tagMenu } from './flow-helpers.ts';
import { git, waitFor, workspaceRoot } from './helpers.ts';

describe('ref operations', () => {
  const { api, panel, ui } = flowSuite();

  it('creates a branch at a commit, switches to it, and undoes that', async () => {
    const at = git('rev-parse', 'main~3');
    const short = git('rev-parse', '--short', at);
    ui.type('strata/new');
    await run('strata.createBranch', commitMenu(at));
    assert.deepEqual(ui.of('input'), [
      {
        kind: 'input',
        title: `Create Branch at ${short} "${git('log', '-1', '--format=%s', at)}"`,
        prompt: 'Creates the branch and switches to it.',
        value: '',
        problem: undefined,
      },
    ]);
    assert.equal(git('branch', '--show-current'), 'strata/new');
    assert.equal(git('rev-parse', 'HEAD'), at);
    await selected(panel(), at);
    assert.deepEqual(ui.of('notify'), [
      { kind: 'notify', level: 'info', message: `Created 'strata/new' at ${short}`, actions: ['Undo'] },
    ]);
    assert.equal(api().contextValue('strata.canUndo'), true);

    await run('strata.undo');
    assert.equal(git('branch', '--show-current'), 'main');
    assert.equal(git('branch', '--list', 'strata/new'), '');
    assert.equal(api().contextValue('strata.canUndo'), false);
  });

  it('drops Undo when HEAD moves to another branch outside Strata', async () => {
    ui.type('strata/elsewhere');
    await run('strata.createBranch', commitMenu(git('rev-parse', 'main~2')));
    assert.equal(api().contextValue('strata.canUndo'), true);
    git('switch', '--quiet', 'main');
    await waitFor('Undo dropped', () => api().contextValue('strata.canUndo') === false);
    await run('strata.undo');
    assert.equal(git('branch', '--list', '--format=%(refname:short)', 'strata/elsewhere'), 'strata/elsewhere');
    assert.equal(git('branch', '--show-current'), 'main');
  });

  it('refuses a branch name that exists, naming where it is', async () => {
    ui.type('main');
    await run('strata.createBranch', commitMenu(git('rev-parse', 'main~1')));
    assert.equal(
      ui.first('input').problem,
      `A branch named 'main' already exists (at ${git('rev-parse', 'main').slice(0, 7)}).`,
    );
    assert.equal(git('branch', '--show-current'), 'main');
  });

  it('deletes a branch with commits no other ref has, after saying so, and undoes that', async () => {
    const tip = git('rev-parse', 'wip/experiment');
    git('config', 'branch.wip/experiment.description', 'Trying things');
    ui.press('Delete Branch and Commits');
    await run('strata.deleteBranch', branchMenu('wip/experiment', tip));
    const asked = ui.first('confirm');
    assert.equal(asked.message, "Delete branch 'wip/experiment' and its 1 unmerged commit?");
    assert.match(asked.detail, /^1 commit would be on no branch, newest "Unmerged experiment"/);
    assert.equal(git('branch', '--list', 'wip/experiment'), '');
    await selected(panel(), git('merge-base', 'HEAD', tip));

    await run('strata.undo');
    assert.equal(git('rev-parse', 'wip/experiment'), tip);
    assert.equal(git('config', 'branch.wip/experiment.description'), 'Trying things', 'its configuration is back');
    await selected(panel(), tip);
  });

  it('refuses a menu on a branch that is gone, says so and refreshes the graph', async () => {
    const before = (await panel().probe()).generation;
    await run('strata.deleteBranch', branchMenu('strata-gone'));
    assert.deepEqual(ui.asked, [
      {
        kind: 'notify',
        level: 'error',
        message: "'strata-gone' no longer exists; the graph has been refreshed.",
        actions: [],
      },
    ]);
    assert.ok((await panel().probe()).generation > before);
  });

  it('does nothing when the branch moved while the confirmation was open', async () => {
    const tip = git('rev-parse', 'wip/experiment');
    ui.press('Delete Branch and Commits').meanwhile(() => git('update-ref', 'refs/heads/wip/experiment', 'main'));
    await run('strata.deleteBranch', branchMenu('wip/experiment', tip));
    assert.equal(git('rev-parse', 'wip/experiment'), git('rev-parse', 'main'));
    assert.deepEqual(ui.of('notify'), [
      {
        kind: 'notify',
        level: 'error',
        message: "'wip/experiment' changed while you were deciding; nothing was done.",
        actions: [],
      },
    ]);
  });

  it('stashes changes a checkout would overwrite, and says when they come back with conflicts', async () => {
    writeFileSync(join(workspaceRoot(), 'NOTES.md'), 'mine\n');
    git('stash', 'push', '--quiet', '--message', 'my own');
    writeFileSync(join(workspaceRoot(), 'main.txt'), 'dirty\n');
    ui.press('Stash & Switch');
    await run('strata.checkout', branchMenu('feature/search', git('rev-parse', 'feature/search')));
    const asked = ui.first('confirm');
    assert.equal(asked.message, "Switching to 'feature/search' would overwrite your changes to 1 file.");
    assert.match(asked.detail, /^main\.txt\. Stash them and bring them back after switching, or let git merge/);
    assert.match(asked.detail, /Uncommitted changes: 1 file\./);
    assert.deepEqual(asked.buttons, ['Stash & Switch', 'Migrate Changes']);
    assert.equal(git('branch', '--show-current'), 'feature/search');
    assert.equal(
      ui.of('notify').find((n) => n.level === 'warning')?.message,
      "Switched to 'feature/search', but restoring your stashed changes conflicted in 1 file (main.txt). Your changes are safe in stash@{0} (\"On main: Strata autostash: switch to 'feature/search'\").",
    );
    assert.equal(
      git('stash', 'list', '--format=%gs'),
      "On main: Strata autostash: switch to 'feature/search'\nOn main: my own",
      'the stash Strata made is kept, the older one untouched',
    );
  });

  it('lets git merge the changes into the target, and says when that conflicted', async () => {
    writeFileSync(join(workspaceRoot(), 'main.txt'), 'dirty\n');
    ui.press('Migrate Changes');
    await run('strata.checkout', branchMenu('feature/search', git('rev-parse', 'feature/search')));
    assert.equal(git('branch', '--show-current'), 'feature/search');
    assert.equal(
      ui.of('notify').find((n) => n.level === 'warning')?.message,
      "Switched to 'feature/search'; your changes conflicted in 1 file.",
    );
    assert.equal(git('stash', 'list'), '');
  });

  it('asks before leaving commits that only a detached HEAD reaches', async () => {
    git('switch', '--quiet', '--detach', 'main');
    const lonely = git('commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'Lonely');
    git('update-ref', '--no-deref', 'HEAD', lonely);
    ui.press('Switch Anyway');
    await run('strata.checkoutDetached', commitMenu(git('rev-parse', 'main~1')));
    const asked = ui.first('confirm');
    assert.equal(asked.message, 'Leave 1 commit behind?');
    assert.match(asked.detail, /\(newest "Lonely"\)/);
    assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', 'main~1'));
  });

  it('creates an annotated tag, deletes it, and undo brings back the same tag', async () => {
    const at = git('rev-parse', 'main~2');
    ui.type('v9.9', 'Release 9.9');
    await run('strata.createTag', commitMenu(at));
    const object = git('rev-parse', 'refs/tags/v9.9');
    assert.equal(git('cat-file', '-t', object), 'tag');
    await selected(panel(), at);

    ui.press('Delete Tag');
    await run('strata.deleteTag', tagMenu('v9.9'));
    assert.equal(ui.first('confirm').message, "Delete tag 'v9.9'?");
    assert.equal(git('tag', '--list', 'v9.9'), '');
    await run('strata.undo');
    assert.equal(git('rev-parse', 'refs/tags/v9.9'), object);
  });

  it('renames a branch and undoes that', async () => {
    ui.type('wip/renamed');
    await run('strata.renameBranch', branchMenu('wip/experiment', git('rev-parse', 'wip/experiment')));
    const branches = () => git('branch', '--list', '--format=%(refname:short)', 'wip/*');
    assert.equal(branches(), 'wip/renamed');
    await run('strata.undo');
    assert.equal(branches(), 'wip/experiment');
  });
});
