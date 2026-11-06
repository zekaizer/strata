import * as assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as vscode from 'vscode';
import { join } from 'node:path';
import { parseGitVersion } from '../../src/core/git-version.ts';
import {
  badge,
  branchMenu,
  commitMenu,
  flowSuite,
  menu,
  reload,
  remoteMenu,
  run,
  selected,
  stashRow,
  tagMenu,
} from './flow-helpers.ts';
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
    assert.deepEqual(ui.of('notify'), [], 'history is as it was: the status bar says it');
    await waitFor('announced', async () => (await panel().probe()).announced === `Created 'strata/new' at ${short}`);
    assert.equal(api().contextValue('strata.canUndo'), true);

    await run('strata.undo');
    assert.equal(git('branch', '--show-current'), 'main');
    assert.equal(git('branch', '--list', 'strata/new'), '');
    assert.equal(api().contextValue('strata.canUndo'), false);
  });

  it('checks out the branch of a commit row, not its commit', async () => {
    git('branch', 'strata-tip', 'main~2');
    await reload(panel());
    await run('strata.checkout', {
      ...commitMenu(git('rev-parse', 'strata-tip')),
      strataBranch: 'refs/heads/strata-tip',
    });
    assert.equal(git('branch', '--show-current'), 'strata-tip');
  });

  it("says so when a notification's Undo is clicked after a newer operation", async () => {
    git('branch', 'strata-one', 'main~1');
    git('branch', 'strata-two', 'main~1');
    await reload(panel());
    const click = ui.later();
    await run('strata.deleteBranch', branchMenu('strata-one', git('rev-parse', 'main~1')));
    const undoOne = await click;
    await run('strata.deleteBranch', branchMenu('strata-two', git('rev-parse', 'main~1')));
    ui.clear();
    await undoOne('Undo');
    assert.deepEqual(ui.of('notify'), [
      { kind: 'notify', level: 'info', message: 'Undo is no longer available: a newer operation ran.', actions: [] },
    ]);
    assert.equal(git('branch', '--list', 'strata-one'), '', 'not restored');
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

  it('refuses a branch name that would put a branch inside another, or the other way around', async () => {
    ui.type('feature');
    await run('strata.createBranch', commitMenu(git('rev-parse', 'main~1')));
    assert.match(
      ui.first('input').problem ?? '',
      /^A branch can't be named 'feature' while the branch 'feature\/\w+' exists\.$/,
    );
    ui.clear();
    ui.type('main/next');
    await run('strata.createBranch', commitMenu(git('rev-parse', 'main~1')));
    assert.equal(ui.first('input').problem, "A branch can't be named 'main/next' while the branch 'main' exists.");
    assert.equal(git('branch', '--show-current'), 'main');
  });

  it('renames a branch into a name under its own', async () => {
    const tip = git('rev-parse', 'wip/experiment');
    ui.type('wip/experiment/old');
    await run('strata.renameBranch', branchMenu('wip/experiment', tip));
    assert.equal(ui.first('input').problem, undefined);
    assert.equal(git('rev-parse', 'refs/heads/wip/experiment/old'), tip);
  });

  it('creates nothing when the branch or tag appeared since the graph read its refs, and refreshes', async () => {
    const at = git('rev-parse', 'main~3');
    ui.type('strata/new').meanwhile(() => git('branch', 'strata/new', 'main~1'));
    await run('strata.createBranch', commitMenu(at));
    assert.deepEqual(ui.of('notify'), [
      {
        kind: 'notify',
        level: 'info',
        message: "A branch named 'strata/new' now exists; nothing was done.",
        actions: [],
      },
    ]);
    assert.equal(git('rev-parse', 'strata/new'), git('rev-parse', 'main~1'));
    assert.equal(git('branch', '--show-current'), 'main');
    await badge(panel(), 'strata/new');

    ui.clear();
    ui.type('v9.7', '').meanwhile(() => git('tag', 'v9.7', 'main~1'));
    await run('strata.createTag', commitMenu(at));
    assert.deepEqual(ui.of('notify'), [
      { kind: 'notify', level: 'info', message: "A tag named 'v9.7' now exists; nothing was done.", actions: [] },
    ]);
    assert.equal(git('rev-parse', 'v9.7'), git('rev-parse', 'main~1'));
    await badge(panel(), 'v9.7');
  });

  it('creates no local branch for a remote branch when one appeared since the graph read its refs', async () => {
    git('remote', 'add', 'origin', join(tmpdir(), 'strata-no-such-remote'));
    git('update-ref', 'refs/remotes/origin/strata-remote', 'main~1');
    git('switch', '--quiet', '--detach', 'main');
    const lonely = git('commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'Lonely');
    git('update-ref', '--no-deref', 'HEAD', lonely);
    await reload(panel());
    ui.press('Switch Anyway').meanwhile(() => git('branch', 'strata-remote', 'main~2'));
    await run('strata.checkout', remoteMenu('origin/strata-remote'));
    assert.deepEqual(ui.of('notify'), [
      {
        kind: 'notify',
        level: 'info',
        message: "A branch named 'strata-remote' now exists; nothing was done.",
        actions: [],
      },
    ]);
    assert.equal(git('rev-parse', 'HEAD'), lonely);
    assert.equal(git('rev-parse', 'strata-remote'), git('rev-parse', 'main~2'));
    await badge(panel(), 'strata-remote');
  });

  describe('checkout of a remote branch whose local namesake tracks another', () => {
    const setUp = async () => {
      for (const remote of ['origin', 'upstream'])
        git('remote', 'add', remote, join(tmpdir(), 'strata-no-such-remote'));
      git('update-ref', 'refs/remotes/origin/strata-up', 'main~1');
      git('update-ref', 'refs/remotes/upstream/strata-up', 'main~2');
      git('branch', '--quiet', '--track', 'strata-up', 'upstream/strata-up');
      await reload(panel());
    };
    const asked = {
      kind: 'confirm',
      message: "'strata-up' tracks 'upstream/strata-up', not 'origin/strata-up'.",
      detail: '',
      buttons: ['Create Tracking Branch...', "Switch to 'strata-up'"],
    };

    it('switches to the local branch when told to', async () => {
      await setUp();
      ui.press("Switch to 'strata-up'");
      await run('strata.checkout', remoteMenu('origin/strata-up'));
      assert.deepEqual(ui.of('confirm'), [asked]);
      assert.equal(git('branch', '--show-current'), 'strata-up');
      assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', 'main~2'));
    });

    it('creates a branch of another name tracking the remote branch', async () => {
      await setUp();
      ui.press('Create Tracking Branch...').type('strata-up');
      await run('strata.checkout', remoteMenu('origin/strata-up'));
      assert.deepEqual(ui.of('input'), [
        {
          kind: 'input',
          title: "Create Branch Tracking 'origin/strata-up'",
          prompt: 'Creates the branch and switches to it.',
          value: 'origin-strata-up',
          problem: `A branch named 'strata-up' already exists (at ${git('rev-parse', '--short=7', 'main~2')}).`,
        },
      ]);
      assert.equal(git('branch', '--show-current'), 'main', 'a name in use is refused');

      ui.clear();
      ui.press('Create Tracking Branch...').type('origin-strata-up');
      await run('strata.checkout', remoteMenu('origin/strata-up'));
      assert.equal(git('branch', '--show-current'), 'origin-strata-up');
      assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', 'main~1'));
      assert.equal(git('rev-parse', '--abbrev-ref', 'origin-strata-up@{upstream}'), 'origin/strata-up');
      assert.equal(git('rev-parse', '--abbrev-ref', 'strata-up@{upstream}'), 'upstream/strata-up');
    });
  });

  it('deletes a branch with commits no other ref has, after saying so, and undoes that', async () => {
    const tip = git('rev-parse', 'wip/experiment');
    git('config', 'branch.wip/experiment.description', 'Trying things');
    ui.press('Delete Branch and Commits');
    await run('strata.deleteBranch', branchMenu('wip/experiment', tip));
    const asked = ui.first('confirm');
    assert.equal(asked.message, "Delete branch 'wip/experiment' and its 1 unmerged commit?");
    assert.match(asked.detail, /^1 commit would be on no branch, newest [0-9a-f]+ "Unmerged experiment"\./);
    assert.equal(git('branch', '--list', 'wip/experiment'), '');
    await selected(panel(), git('merge-base', 'HEAD', tip));

    await run('strata.undo');
    assert.equal(git('rev-parse', 'wip/experiment'), tip);
    assert.equal(git('config', 'branch.wip/experiment.description'), 'Trying things', 'its configuration is back');
    await selected(panel(), tip);
  });

  it('deletes a branch whose commits another ref has without asking, and undoes that', async () => {
    git('branch', 'strata-merged', 'main~1');
    await reload(panel());
    await run('strata.deleteBranch', branchMenu('strata-merged', git('rev-parse', 'main~1')));
    assert.deepEqual(ui.of('confirm'), []);
    assert.equal(git('branch', '--list', 'strata-merged'), '');
    await run('strata.undo');
    assert.equal(git('rev-parse', 'strata-merged'), git('rev-parse', 'main~1'));
  });

  it('refuses a menu on a branch that is gone, says so and refreshes the graph', async () => {
    await run('strata.deleteBranch', branchMenu('strata-gone'));
    assert.deepEqual(ui.asked, [
      {
        kind: 'notify',
        level: 'info',
        message: "'strata-gone' no longer exists; the graph has been refreshed.",
        actions: [],
      },
    ]);
  });

  it('does nothing when the branch moved while the confirmation was open', async () => {
    const tip = git('rev-parse', 'wip/experiment');
    ui.press('Delete Branch and Commits').meanwhile(() => git('update-ref', 'refs/heads/wip/experiment', 'main'));
    await run('strata.deleteBranch', branchMenu('wip/experiment', tip));
    assert.equal(git('rev-parse', 'wip/experiment'), git('rev-parse', 'main'));
    assert.deepEqual(ui.of('notify'), [
      {
        kind: 'notify',
        level: 'info',
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
    assert.equal(
      asked.detail,
      "'feature/search' changes main.txt too.\nUncommitted changes in 1 file; untracked files stay in place.",
    );
    assert.deepEqual(asked.buttons, ['Stash & Switch', 'Migrate Changes']);
    assert.equal(git('branch', '--show-current'), 'feature/search');
    assert.equal(
      ui.of('notify').find((n) => n.level === 'warning')?.message,
      "Switched to 'feature/search'; restoring your stashed changes conflicted in main.txt. They stay in stash \"Strata: changes set aside for the switch to 'feature/search'\".",
    );
    assert.equal(
      git('stash', 'list', '--format=%gs'),
      "On main: Strata: changes set aside for the switch to 'feature/search'\nOn main: my own",
      'the stash Strata made is kept, the older one untouched',
    );
  });

  const write = (file: string, content: string) => {
    writeFileSync(join(workspaceRoot(), file), content);
  };
  const read = (file: string) => readFileSync(join(workspaceRoot(), file), 'utf8');
  /** strata-new: one commit on main writing `files` ("theirs"); HEAD stays on main. */
  const adding = async (files: Record<string, string>) => {
    git('switch', '--quiet', '--create', 'strata-new', 'main');
    for (const [f, content] of Object.entries(files)) write(f, content);
    git('add', '--', ...Object.keys(files));
    git('commit', '--quiet', '-m', 'Theirs');
    git('switch', '--quiet', 'main');
    await reload(panel());
    return git('rev-parse', 'strata-new');
  };

  it('moves untracked files in the way of a checkout into a stash it never pops, when told to', async () => {
    const tip = await adding({ 'new.txt': 'theirs\n', 'two words.txt': 'theirs\n' });
    write('new.txt', 'mine\n');
    write('two words.txt', 'mine too\n');
    await run('strata.checkout', branchMenu('strata-new', tip));
    assert.deepEqual(ui.of('confirm'), [
      {
        kind: 'confirm',
        message: "2 untracked files are in the way of the switch to 'strata-new': new.txt and two words.txt.",
        detail:
          "The stash keeps them; Strata doesn't bring them back, because the switch to 'strata-new' puts its own versions there.",
        buttons: ['Stash Them & Retry'],
      },
    ]);
    assert.equal(git('branch', '--show-current'), 'main', 'cancelled: nothing changed');
    assert.equal(read('new.txt'), 'mine\n');
    assert.equal(git('stash', 'list'), '');

    ui.clear();
    ui.press('Stash Them & Retry');
    await run('strata.checkout', branchMenu('strata-new', tip));
    assert.equal(git('branch', '--show-current'), 'strata-new');
    assert.equal(read('new.txt'), 'theirs\n');
    assert.deepEqual(
      ui.of('notify').filter((n) => n.level !== 'info'),
      [],
    );
    assert.equal(
      git('stash', 'list', '--format=%gs'),
      "On main: Strata: untracked files in the way of switch to 'strata-new'",
    );
    assert.equal(git('show', 'stash@{0}^3:two words.txt'), 'mine too');
    assert.equal(git('diff', '--stat', 'stash@{0}^1', 'stash@{0}'), '', 'no tracked changes in it');
    const row = await stashRow(panel(), git('rev-parse', 'refs/stash'));
    assert.equal(row.autostash, false, 'not an autostash Strata owes a restore');
    assert.equal((await panel().probe()).leftover, undefined);
  });

  it('stashes around a checkout again after moving untracked files out of its way', async () => {
    const lines = (first: string, last: string) => `${first}\n2\n3\n4\n${last}\n`;
    write('lines.txt', lines('1', '5'));
    git('add', 'lines.txt');
    git('commit', '--quiet', '-m', 'Lines');
    const tip = await adding({ 'lines.txt': lines('one', '5'), 'new.txt': 'theirs\n' });
    write('lines.txt', lines('1', 'five'));
    write('new.txt', 'mine\n');
    ui.press('Stash & Switch', 'Stash It & Retry');
    await run('strata.checkout', branchMenu('strata-new', tip));
    assert.deepEqual(
      ui.of('confirm').map((q) => q.message),
      [
        "Switching to 'strata-new' would overwrite your changes to 1 file.",
        "1 untracked file is in the way of the switch to 'strata-new': new.txt.",
      ],
    );
    assert.equal(git('branch', '--show-current'), 'strata-new');
    assert.equal(read('lines.txt'), lines('one', 'five'), 'the stashed change came back');
    assert.equal(
      git('stash', 'list', '--format=%gs'),
      "On main: Strata: untracked files in the way of switch to 'strata-new'",
      "only the untracked files' stash is left",
    );
    assert.deepEqual(
      ui.of('notify').filter((n) => n.level !== 'info'),
      [],
    );
    await stashRow(panel(), git('rev-parse', 'refs/stash'));
    assert.equal((await panel().probe()).leftover, undefined);
  });

  it("shows git's error when the files it names in the way are not untracked files here", async () => {
    // git lists names unquoted: one with a newline in it comes back as two that name no file.
    const tip = await adding({ 'a\nb.txt': 'theirs\n' });
    write('a\nb.txt', 'mine\n');
    await run('strata.checkout', branchMenu('strata-new', tip));
    assert.deepEqual(ui.of('confirm'), []);
    assert.match(
      ui.of('notify').find((n) => n.level === 'error')?.message ?? '',
      /^Couldn't switch to 'strata-new': error: The following untracked working tree files would be overwritten by checkout:\n\ta\nb\.txt$/,
    );
    assert.equal(git('branch', '--show-current'), 'main');
  });

  it('lets git merge the changes into the target, and says when that conflicted', async () => {
    writeFileSync(join(workspaceRoot(), 'main.txt'), 'dirty\n');
    ui.press('Migrate Changes');
    await run('strata.checkout', branchMenu('feature/search', git('rev-parse', 'feature/search')));
    assert.equal(git('branch', '--show-current'), 'feature/search');
    const warning = ui.of('notify').find((n) => n.level === 'warning')?.message;
    const [major, minor] = parseGitVersion(git('version'))!;
    if (major > 2 || minor >= 55) {
      // git 2.55 keeps the changes in a stash when merging them conflicts.
      assert.equal(
        warning,
        "Switched to 'feature/search'; restoring your stashed changes conflicted in main.txt. They stay in stash \"autostash while switching to 'feature/search'\".",
      );
      assert.equal(git('stash', 'list', '--format=%gs'), "autostash while switching to 'feature/search'");
    } else {
      assert.equal(warning, "Switched to 'feature/search'; your changes conflicted in main.txt.");
      assert.equal(git('stash', 'list'), '');
    }
  });

  it('asks before leaving commits that only a detached HEAD reaches', async () => {
    git('switch', '--quiet', '--detach', 'main');
    const lonely = git('commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'Lonely');
    git('update-ref', '--no-deref', 'HEAD', lonely);
    ui.press('Switch Anyway');
    await run('strata.checkoutDetached', commitMenu(git('rev-parse', 'main~1')));
    const asked = ui.first('confirm');
    assert.equal(asked.message, 'Leave 1 commit behind?');
    assert.match(asked.detail, /; newest [0-9a-f]+ "Lonely"\./);
    assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', 'main~1'));
  });

  it('creates an annotated tag, deletes it, and undo brings back the same tag', async () => {
    const at = git('rev-parse', 'main~2');
    ui.type('v9.9', 'Release 9.9');
    await run('strata.createTag', commitMenu(at));
    const object = git('rev-parse', 'refs/tags/v9.9');
    assert.equal(git('cat-file', '-t', object), 'tag');
    await selected(panel(), at);

    await run('strata.deleteTag', tagMenu('v9.9'));
    assert.deepEqual(ui.of('confirm'), [], 'Undo restores the tag: nothing to confirm');
    assert.equal(git('tag', '--list', 'v9.9'), '');
    await run('strata.undo');
    assert.equal(git('rev-parse', 'refs/tags/v9.9'), object);
  });

  it('creates a lightweight tag and undoes the deletion of an annotated one, with tag.gpgSign set', async () => {
    git('config', 'tag.gpgSign', 'true');
    const at = git('rev-parse', 'main~2');
    ui.type('v9.8', '');
    await run('strata.createTag', commitMenu(at));
    assert.equal(git('cat-file', '-t', 'refs/tags/v9.8'), 'commit');
    assert.deepEqual(ui.of('notify'), []);

    git('-c', 'tag.gpgSign=false', 'tag', '--annotate', '--message', 'Release 9.9', 'v9.9', at);
    const object = git('rev-parse', 'refs/tags/v9.9');
    await reload(panel());
    await run('strata.deleteTag', tagMenu('v9.9'));
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

  it("offers a row's badge actions from the row's menu, for keyboard users", async () => {
    const tip = git('rev-parse', 'wip/experiment');
    ui.choose('Copy Name');
    await run(
      'strata.refActions',
      menu({ webviewSection: 'commit', strataHash: tip, strataHasRefs: true, strataRefs: 'refs/heads/wip/experiment' }),
    );
    assert.deepEqual(ui.first('pick'), {
      kind: 'pick',
      title: "Actions for 'wip/experiment'",
      items: [
        'Checkout',
        'Merge into Current Branch...',
        'Rebase Current Branch onto This...',
        'Publish Branch...',
        'Set Upstream...',
        'Rename Branch...',
        'Copy Name',
        'Hide Badge',
        'Hide Similar Badges...',
        'Delete Branch...',
      ],
    });
    assert.equal(await vscode.env.clipboard.readText(), 'wip/experiment');
  });

  it('refuses to rename a branch checked out in another worktree, naming it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'strata-wt-'));
    const other = join(root, 'other');
    git('worktree', 'add', '--quiet', other, 'wip/experiment');
    try {
      await run('strata.renameBranch', branchMenu('wip/experiment', git('rev-parse', 'wip/experiment')));
      assert.deepEqual(ui.asked, [
        {
          kind: 'notify',
          level: 'error',
          message: `'wip/experiment' is checked out in worktree 'other' (${other}).`,
          actions: ['Open Worktree in New Window'],
        },
      ]);
    } finally {
      git('worktree', 'remove', '--force', other);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
