import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { autostashMessage, strataAutostashOf } from '../../src/core/autostash.ts';
import { checkedOutPath } from '../../src/core/git-error.ts';
import { remoteBranch } from '../../src/core/remote-branch.ts';
import {
  changedMeanwhile,
  checkedOutElsewhere,
  createBranchInput,
  createTagInput,
  DOING,
  DONE,
  leaveBehindConfirmation,
  migrateConflicted,
  NEEDS_NEW_NAME,
  popConflicted,
  refAppeared,
  refExists,
  refPathConflict,
  renameInput,
  stashButtons,
  stashLabel,
  staleTarget,
  switchConfirmation,
  tagMessageInput,
  trackingBranchInput,
  tracksOtherConfirmation,
} from '../../src/core/wording.ts';

const tip = { short: 'abc1234', subject: 'Tip' };
const labels = (b: { label: string }[]) => b.map((x) => x.label);

describe('wording of ref operations', () => {
  it('labels the answers for uncommitted changes with the operation', () => {
    assert.deepEqual(labels(stashButtons('switch', ['stash', 'migrate'])), ['Stash & Switch', 'Migrate Changes']);
    assert.deepEqual(labels(stashButtons('merge', ['keep', 'stash'])), ['Merge Keeping Changes', 'Stash & Merge']);
    assert.deepEqual(labels(stashButtons('cherryPick', ['stash', 'keep'])), [
      'Stash & Cherry Pick',
      'Cherry Pick Keeping Changes',
    ]);
    assert.deepEqual(labels(stashButtons('pullRebase', ['stash'])), ['Stash & Pull']);
    assert.deepEqual(labels(stashButtons('resetHard', ['stash', 'discard'])), [
      'Stash Changes & Reset',
      'Discard Changes & Reset',
    ]);
    assert.deepEqual(
      stashButtons('switch', ['migrate']).map((b) => b.id),
      ['migrate'],
    );
  });

  it('names the files a switch would overwrite and both ways out', () => {
    const c = switchConfirmation("'topic'", ['a.txt', 'b.txt'], 'Uncommitted changes: 2 files.', [
      { id: 'stash', label: 'Stash & Switch' },
    ]);
    assert.equal(c.message, "Switching to 'topic' would overwrite your changes to 2 files.");
    assert.equal(c.detail, "'topic' changes a.txt and b.txt too.\nUncommitted changes: 2 files.");
    assert.equal(
      switchConfirmation('abc1234', ['a.txt'], '', []).message,
      'Switching to abc1234 would overwrite your changes to 1 file.',
    );
  });

  it('warns before leaving commits on no branch', () => {
    const c = leaveBehindConfirmation(2, { short: 'abc1234', subject: 'WIP' });
    assert.equal(c.message, 'Leave 2 commits behind?');
    assert.equal(
      c.detail,
      'No branch has them; newest abc1234 "WIP".\nUndo can\'t bring them back; only the reflog keeps them.',
    );
    assert.deepEqual(labels(c.buttons), ['Switch Anyway']);
    assert.equal(leaveBehindConfirmation(1, tip).message, 'Leave 1 commit behind?');
  });

  it('asks for new branch and tag names at a commit', () => {
    assert.deepEqual(createBranchInput(tip), {
      title: 'Create Branch at abc1234 "Tip"',
      prompt: 'Creates the branch and switches to it.',
    });
    assert.equal(createTagInput(tip).title, 'Create Tag at abc1234 "Tip"');
    assert.deepEqual(tagMessageInput('v1', tip), {
      title: "Create Tag 'v1' at abc1234",
      prompt: 'Message (empty for a lightweight tag)',
    });
    assert.equal(refExists('branch', 'main', 'abc1234'), "A branch named 'main' already exists (at abc1234).");
    assert.equal(refExists('tag', 'v1', 'abc1234'), "A tag named 'v1' already exists (at abc1234).");
    assert.equal(
      refPathConflict('branch', 'feature/x', 'feature'),
      "A branch can't be named 'feature/x' while the branch 'feature' exists.",
    );
    assert.equal(refPathConflict('tag', 'v1', 'v1/rc'), "A tag can't be named 'v1' while the tag 'v1/rc' exists.");
  });

  it('asks what to do when the local namesake of a remote branch tracks another', () => {
    assert.deepEqual(tracksOtherConfirmation('main', 'upstream/main', 'origin/main'), {
      level: 'info',
      message: "'main' tracks 'upstream/main', not 'origin/main'.",
      detail: '',
      buttons: [
        { id: 'new', label: 'Create Tracking Branch...' },
        { id: 'switch', label: "Switch to 'main'" },
      ],
    });
    assert.deepEqual(trackingBranchInput('origin/main'), {
      title: "Create Branch Tracking 'origin/main'",
      prompt: 'Creates the branch and switches to it.',
    });
  });

  it('says a renamed branch keeps its remote name', () => {
    assert.deepEqual(renameInput('topic', 'origin'), {
      title: "Rename Branch 'topic'",
      prompt: "Enter the new name. 'topic' on 'origin' keeps its name.",
    });
    assert.equal(renameInput('topic', undefined).prompt, 'Enter the new name.');
    assert.equal(NEEDS_NEW_NAME, 'Enter a different name.');
  });

  it('reports what went wrong around a switch', () => {
    assert.equal(staleTarget('gone'), "'gone' no longer exists; the graph has been refreshed.");
    assert.equal(changedMeanwhile("'topic'"), "'topic' changed while you were deciding; nothing was done.");
    assert.equal(refAppeared('branch', 'topic'), "A branch named 'topic' now exists; nothing was done.");
    assert.equal(checkedOutElsewhere('topic', '/r/wt'), "'topic' is checked out in another worktree (/r/wt).");
    assert.equal(checkedOutElsewhere('topic', undefined), "'topic' is checked out in another worktree.");
    const wt = { path: '/r/wt', name: 'wt', head: undefined, branch: 'refs/heads/topic', main: false };
    assert.equal(
      checkedOutElsewhere('topic', { ...wt, state: { kind: 'active' } }),
      "'topic' is checked out in worktree 'wt' (/r/wt).",
    );
    assert.equal(
      checkedOutElsewhere('topic', { ...wt, state: { kind: 'locked', reason: 'on usb disk' } }),
      "'topic' is checked out in worktree 'wt' (/r/wt). It is locked: on usb disk.",
    );
    assert.equal(
      checkedOutElsewhere('topic', { ...wt, state: { kind: 'prunable', reason: 'gone' } }),
      "'topic' is checked out in worktree 'wt' (/r/wt). Its folder is gone; pruning the worktree frees the branch.",
    );
    assert.equal(
      popConflicted("Switched to 'topic'", ['a.txt'], stashLabel('autostash')),
      "Switched to 'topic'; restoring your stashed changes conflicted in a.txt. They stay in the stash git made.",
    );
    assert.equal(
      migrateConflicted("Switched to 'topic'", ['a.txt', 'b.txt']),
      "Switched to 'topic'; your changes conflicted in a.txt and b.txt.",
    );
  });
});

describe("Strata's autostash entries", () => {
  it('are recognised by their message, whatever branch they were made on', () => {
    const message = autostashMessage('cherryPick', "a1b2c3d onto 'main'");
    assert.equal(message, "Strata: changes set aside for the cherry pick a1b2c3d onto 'main'");
    assert.equal(strataAutostashOf(`On main: ${message}`), 'cherryPick');
    assert.equal(strataAutostashOf(`On feature/x: ${autostashMessage('switch', "to 'b'")}`), 'switch');
    assert.equal(strataAutostashOf(`On main: ${autostashMessage('revert', 'a1b2c3d')}`), 'revert');
    assert.equal(strataAutostashOf('autostash'), undefined, "git's own autostash");
    assert.equal(strataAutostashOf('On main: my work'), undefined);
    assert.equal(strataAutostashOf('WIP on main: abc1234 Strata autostash: cherry pick x'), undefined);
  });

  it('are still recognised by the prefix older versions wrote', () => {
    assert.equal(strataAutostashOf("On main: Strata autostash: cherry pick a1b2c3d onto 'main'"), 'cherryPick');
    assert.equal(strataAutostashOf("On main: Strata autostash: switch to 'b'"), 'switch');
  });

  it("name a stash by its message, without git's prefix", () => {
    assert.equal(stashLabel('On main: half-done lexer'), 'stash "half-done lexer"');
    assert.equal(stashLabel('WIP on feature/x: 1a2b3c4 Add lexer'), 'stash "Add lexer"');
    assert.equal(stashLabel('autostash'), 'the stash git made');
  });
});

describe('remote-tracking branch names', () => {
  it('split at the longest known remote', () => {
    assert.deepEqual(remoteBranch('refs/remotes/origin/feature/x', ['origin']), {
      remote: 'origin',
      branch: 'feature/x',
    });
    assert.deepEqual(remoteBranch('refs/remotes/team/x/main', ['team', 'team/x']), {
      remote: 'team/x',
      branch: 'main',
    });
    assert.equal(remoteBranch('refs/remotes/gone/main', ['origin']), undefined);
    assert.equal(remoteBranch('refs/remotes/origin/HEAD', ['origin']), undefined);
  });
});

describe('checkedOutPath', () => {
  it('finds the worktree git names', () => {
    assert.equal(checkedOutPath("fatal: 'x' is already used by worktree at '/a/b'"), '/a/b');
    assert.equal(checkedOutPath("error: cannot delete branch 'x' used by worktree at '/a/b'"), '/a/b');
    assert.equal(checkedOutPath("fatal: 'x' is already checked out at '/p q'"), '/p q');
    assert.equal(checkedOutPath('fatal: something else'), undefined);
  });
});

describe('results and progress of ref operations', () => {
  it('says what was done', () => {
    const cases: [string, string][] = [
      [DONE.switched('topic'), "Switched to 'topic'"],
      [DONE.switched('x', { count: 3, upstream: 'origin/x' }), "Switched to 'x' (3 behind 'origin/x')"],
      [DONE.tracking('x', 'origin/x'), "Created 'x' tracking 'origin/x'"],
      [DONE.detached('abc1234'), 'Detached HEAD at abc1234'],
      [DONE.branchCreated('x', 'abc1234'), "Created 'x' at abc1234"],
      [DONE.tagCreated('v1', 'abc1234'), "Created tag 'v1' at abc1234"],
      [DONE.renamed('a', 'b'), "Renamed 'a' to 'b'"],
      [DONE.branchDeleted('x'), "Deleted branch 'x'"],
      [DONE.tagDeleted('v1'), "Deleted tag 'v1'"],
      [DONE.copied('origin/x'), "Copied 'origin/x'"],
      [DONE.copiedHash('abc1234'), 'Copied the commit hash of abc1234'],
      [DONE.copiedShortHash('abc1234'), 'Copied abc1234'],
      [DONE.copiedSubject('abc1234'), 'Copied the subject of abc1234'],
    ];
    for (const [actual, expected] of cases) assert.equal(actual, expected);
  });

  it('says what is running', () => {
    const cases: [string, string][] = [
      [DOING.switching("'topic'"), "Switching to 'topic'"],
      [DOING.creatingBranch('x'), "Creating branch 'x'"],
      [DOING.creatingTag('v1'), "Creating tag 'v1'"],
      [DOING.renaming('x'), "Renaming 'x'"],
      [DOING.deletingBranch('x'), "Deleting branch 'x'"],
      [DOING.deletingTag('v1'), "Deleting tag 'v1'"],
    ];
    for (const [actual, expected] of cases) assert.equal(actual, expected);
  });
});
