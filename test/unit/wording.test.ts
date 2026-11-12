import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  abortConfirmation,
  COMMIT_GRAPH_OFFER,
  commandUnquotable,
  graphTitle,
  deleteBranchConfirmation,
  dirtySection,
  fileList,
  failedDuring,
  gitFailure,
  gitTooOld,
  WRITES_DISABLED,
  rewriteConfirmation,
  rewriteInTheWay,
  rewriteRefused,
  reorderOutdated,
  REORDER_MODE,
  nothingToReorder,
  REWRITE_DOING,
  REWRITE_DONE,
  REWRITE_UNDO,
  type RewriteFacts,
  HISTORY_DONE,
  resetConfirmation,
  signInConfirmation,
  skipConfirmation,
  undoGone,
  undoMovedConfirmation,
  undone,
  type ResetFacts,
} from '../../src/core/wording.ts';

const c = (short: string, subject: string) => ({ short, subject });

describe('wording', () => {
  it('lists a few files and counts the rest', () => {
    assert.equal(fileList(['a']), 'a');
    assert.equal(fileList(['a', 'b']), 'a and b');
    assert.equal(fileList(['a', 'b', 'c', 'd', 'e', 'f', 'g']), 'a, b, c, d, e and 2 more');
  });

  it('describes uncommitted changes and what happens to them', () => {
    const dirty = { files: 3, staged: 1, overlap: true, fastForward: true };
    assert.equal(
      dirtySection(dirty, 'merge', 0),
      'Uncommitted changes in 3 files (1 staged); untracked files stay in place.',
    );
    assert.equal(
      dirtySection(dirty, 'merge', 2),
      'Uncommitted changes in 3 files (1 staged); untracked files and changes inside submodules stay in place.',
    );
  });

  const reset: ResetFacts = {
    branch: 'main',
    target: c('a1b2c3d', 'Base'),
    dropped: { newest: [c('1111111', 'Two'), c('2222222', 'One')], count: 2 },
    gained: 0,
    onUpstream: 0,
    unreachable: 2,
    upstream: 'origin/main',
    dirtyFiles: 0,
  };

  it('names the commits a reset drops and how to get them back', () => {
    const r = resetConfirmation(reset, 'mixed');
    assert.ok(r);
    assert.equal(r.message, "Reset 'main' to a1b2c3d?");
    assert.equal(
      r.detail,
      '\'main\' moves back 2 commits ("Two" and "One"); their changes stay in your files, unstaged.\nUndo brings them back.',
    );
    assert.deepEqual(r.buttons, [{ id: 'reset', label: "Reset 'main'" }]);
  });

  it('warns about discarded work on a hard reset and about the upstream', () => {
    const r = resetConfirmation(
      { ...reset, dropped: { newest: [c('1111111', 'Two')], count: 1 }, onUpstream: 1, unreachable: 0, dirtyFiles: 4 },
      'hard',
    );
    assert.equal(
      r!.detail,
      "'main' moves back 1 commit (\"Two\"); their changes are discarded.\nUndo brings it back (1 also on 'origin/main').",
    );
    const partly = resetConfirmation({ ...reset, onUpstream: 1, unreachable: 1 }, 'keep');
    assert.match(
      partly!.detail,
      /\nUndo brings them back \(1 on no other branch; 1 also on 'origin\/main'\)\.\nYour uncommitted changes stay\.$/,
    );
  });

  it('counts the commits a reset drops beyond those it names', () => {
    const r = resetConfirmation({ ...reset, dropped: { newest: reset.dropped.newest, count: 60 } }, 'mixed');
    assert.match(r!.detail, /^'main' moves back 60 commits \("Two", "One" and 58 more\);/);
  });

  it('asks nothing for a reset that drops nothing and discards nothing', () => {
    assert.equal(resetConfirmation({ ...reset, dropped: { newest: [], count: 0 }, unreachable: 0 }, 'soft'), undefined);
    assert.ok(
      resetConfirmation({ ...reset, dropped: { newest: [], count: 0 }, unreachable: 0, dirtyFiles: 1 }, 'hard'),
    );
  });

  it('says when deleting a branch loses commits', () => {
    assert.equal(deleteBranchConfirmation('topic', { newest: [], count: 0 }, 'origin/topic'), undefined);
    const lossy = deleteBranchConfirmation(
      'topic',
      { newest: [c('abc1234', 'Tip'), c('def5678', 'Older')], count: 2 },
      undefined,
    );
    assert.ok(lossy);
    assert.equal(lossy.message, "Delete branch 'topic' and its 2 unmerged commits?");
    assert.match(lossy.detail, /^2 commits would be on no branch, newest abc1234 "Tip"\./);
    assert.deepEqual(lossy.buttons, [{ id: 'delete', label: 'Delete Branch and Commits' }]);
    const long = deleteBranchConfirmation('topic', { newest: [c('abc1234', 'Tip')], count: 60 }, undefined);
    assert.equal(long?.message, "Delete branch 'topic' and its 60 unmerged commits?");
  });

  it('says what aborting gives back', () => {
    const a = abortConfirmation('rebase', 'topic', '9f8e7d6', true);
    assert.equal(a.message, 'Abort the rebase?');
    assert.equal(
      a.detail,
      "'topic' goes back to 9f8e7d6, dropping your conflict resolutions.\nStrata can't undo this.\nYour stashed changes come back.",
    );
    assert.deepEqual(a.buttons, [{ id: 'abort', label: 'Abort Rebase' }]);
    assert.match(
      abortConfirmation('cherryPick', undefined, '9f8e7d6', false).detail,
      /^HEAD goes back to 9f8e7d6, dropping your conflict resolutions\.\nStrata can't undo this\.$/,
    );
  });

  it('counts the commits an Abort drops', () => {
    assert.match(
      abortConfirmation('rebase', 'topic', '9f8e7d6', false, [], 2).detail,
      /^'topic' goes back to 9f8e7d6, dropping the 2 commits it replayed and your conflict resolutions\./,
    );
    assert.match(
      abortConfirmation('revert', 'main', '9f8e7d6', false, [], 1).detail,
      /^'main' goes back to 9f8e7d6, dropping the 1 commit it made and your conflict resolutions\./,
    );
  });

  it('names the uncommitted changes an Abort or Skip would discard, and offers to stash them', () => {
    const a = abortConfirmation('merge', 'main', '9f8e7d6', false, ['a.ts']);
    assert.equal(
      a.detail,
      "'main' goes back to 9f8e7d6, dropping your conflict resolutions.\nStrata can't undo this.\nYour uncommitted changes in 1 file (a.ts) would be lost.",
    );
    const s = skipConfirmation(c('abc1234', 'Add lexer'), "'topic'", ['a.ts', 'b.ts']);
    assert.match(
      s.detail,
      /^Its changes won't be in 'topic'\.\nYour uncommitted changes in 2 files \(a\.ts and b\.ts\) would be lost\.$/,
    );
    assert.deepEqual(s.buttons, [
      { id: 'stash', label: 'Stash Changes & Skip' },
      { id: 'discard', label: 'Discard Changes & Skip' },
    ]);
    assert.equal(
      HISTORY_DONE.skipped('abc1234', 'stash@{0} ("x")'),
      'Skipped abc1234. Your uncommitted changes are in stash@{0} ("x")',
    );
  });
});

describe('wording of undo and failures', () => {
  it('asks before an undo that would drop commits made since', () => {
    const now = c('abc1234', 'Later');
    const moved = undoMovedConfirmation('main', 'merge', 0, now, 'def5678');
    assert.equal(moved.message, "'main' has moved since the merge (now at abc1234).");
    assert.equal(moved.detail, 'Undo moves it back to def5678.');
    assert.deepEqual(moved.buttons, [{ id: 'undo', label: 'Undo Anyway' }]);
    assert.match(undoMovedConfirmation(undefined, 'cherry pick', 0, now, 'b').message, /^HEAD has moved since/);
    assert.equal(undone('branch deletion'), 'Undid the branch deletion');
    const created = undoMovedConfirmation('topic', 'branch creation', 2, now, 'def5678');
    assert.equal(created.message, "Undo the branch creation and lose 2 commits on 'topic'?");
    assert.equal(created.detail, 'Made since the branch creation, newest abc1234 "Later".\nStrata can\'t undo this.');
    assert.deepEqual(created.buttons, [{ id: 'undo', label: 'Undo and Drop 2 Commits' }]);
    assert.equal(
      undoGone('rebase', "'main'"),
      "HEAD is now on 'main', not on the branch the rebase moved, so Undo was dropped.",
    );
  });

  it('shows the lines of a failed command that say why, past the banners before them', () => {
    const rejected =
      " ! [remote rejected] main -> main (protected branch hook declined)\nerror: failed to push some refs to 'example.com:x/y.git'";
    assert.equal(
      gitFailure(
        `remote: ==========\nremote: Welcome to Example Git\nremote: ==========\nremote: error: GH006: Protected branch update failed for refs/heads/main.\nTo example.com:x/y.git\n${rejected}\n`,
      ),
      `remote: error: GH006: Protected branch update failed for refs/heads/main.\n${rejected}`,
    );
    assert.equal(
      gitFailure(`Running pre-push checks\nlint: 2 problems\nTo example.com:x/y.git\n${rejected}\n`),
      rejected,
      'a rejection without a line of the server',
    );
    assert.equal(gitFailure('error: one\nhint: two\nhint: three\n'), 'error: one', 'no advice');
    assert.equal(gitFailure('  fatal: bad\n'), 'fatal: bad');
    assert.equal(gitFailure('error: 1\nerror: 2\nerror: 3\nerror: 4\n'), 'error: 1\nerror: 2\nerror: 3');
  });

  it('keeps the files an error lists under it', () => {
    assert.equal(
      gitFailure(
        'Updating 1a2b3c4..5d6e7f8\nerror: Your local changes to the following files would be overwritten by merge:\n\ta.txt\nPlease commit your changes or stash them before you merge.\nAborting\n',
      ),
      'error: Your local changes to the following files would be overwritten by merge:\n\ta.txt',
    );
  });

  it('shows the first three lines of a message that marks no line as the cause', () => {
    assert.equal(
      gitFailure('The previous cherry-pick is now empty.\nTo commit it anyway, use:\n\n    git commit --allow-empty\n'),
      'The previous cherry-pick is now empty.\nTo commit it anyway, use:\n',
    );
  });

  it('names the operation a git failure happened in', () => {
    assert.equal(
      failedDuring("Merging 'topic' into 'main'", 'fatal: x'),
      "Couldn't merge 'topic' into 'main': fatal: x",
    );
    assert.equal(failedDuring('Cherry picking abc1234', 'fatal: x'), "Couldn't cherry pick abc1234: fatal: x");
    assert.equal(failedDuring("Pushing 'x' to 'origin/x'", 'e'), "Couldn't push 'x' to 'origin/x': e");
    assert.equal(failedDuring('Frobbing it', 'e'), 'Frobbing it failed: e');
  });

  it('hands a failed sign-in to a terminal', () => {
    const auth = signInConfirmation('origin', 'auth');
    assert.equal(auth.message, "Strata couldn't sign in to 'origin'.");
    assert.equal(
      auth.detail,
      "git needs you to sign in, which Strata can't show. Run the same command in a terminal to sign in there.",
    );
    assert.deepEqual(
      auth.buttons.map((b) => b.label),
      ['Type in Terminal', 'Show Output'],
    );
    assert.equal(auth.level, 'info');
    assert.equal(signInConfirmation(undefined, 'hostKey').message, "Strata couldn't connect to a remote.");
    assert.equal(
      signInConfirmation('origin', 'hostKey').detail,
      'Connect to the host once from a terminal to accept its key.',
    );
    // Pull's terminal command is only its fetch.
    assert.match(signInConfirmation('origin', 'auth', 'Pull').detail, / to sign in there, then run Pull again\.$/);
    assert.match(signInConfirmation('origin', 'hostKey', 'Pull').detail, / to accept its key, then run Pull again\.$/);
  });

  it('says why a command was not typed into the terminal', () => {
    assert.equal(
      commandUnquotable("git push origin 'a&b'"),
      "Strata can't quote this command safely for your terminal's shell. Run it there yourself, quoted for that shell: git push origin 'a&b'",
    );
  });

  it('names the git that is too old to write', () => {
    assert.equal(gitTooOld('2.33.8'), 'Strata needs git 2.34 or newer to change repositories (found 2.33.8).');
  });

  it('says what follows from a git too old to write', () => {
    assert.equal(WRITES_DISABLED, 'Commands that change the repository are disabled.');
  });
});

/** VS Code's title case for buttons: every word capitalized but short conjunctions, articles and prepositions. */
const titleCase = (label: string) =>
  label
    .split(' ')
    .every(
      (w, i) =>
        (i > 0 && /^(a|an|and|as|at|but|by|for|in|into|nor|of|on|onto|or|the|to|with)$/.test(w)) || /^[^a-z]/.test(w),
    );

describe('commit-graph offer', () => {
  it('labels its buttons in title case, as every other notification does', () => {
    const labels = [
      ...COMMIT_GRAPH_OFFER.graph('zephyr', 'history').buttons,
      ...COMMIT_GRAPH_OFFER.graph('zephyr', 'paths').buttons,
      ...COMMIT_GRAPH_OFFER.filters('kernel/sched.c').buttons,
      COMMIT_GRAPH_OFFER.later,
      COMMIT_GRAPH_OFFER.never,
    ];
    assert.deepEqual(
      labels.filter((l) => !titleCase(l)),
      [],
    );
  });
  it('says a slow search is what it speeds up, and that searches for rare text stay as they are', () => {
    const { message } = COMMIT_GRAPH_OFFER.graph('zephyr', 'find');
    assert.match(message, /^Searching zephyr is slow because the repository has no commit-graph\./);
    assert.match(message, /git commit-graph write --reachable\)/);
    assert.match(message, /first matches/);
  });
});

describe('graph tab title', () => {
  it('is the shown repository, and Strata before there is one; the tab icon says it is the graph', () => {
    assert.equal(graphTitle('alpha'), 'alpha');
    assert.equal(graphTitle(undefined), 'Strata');
  });
});

describe('rewrite confirmation', () => {
  const facts: RewriteFacts = {
    edit: 'reword',
    branch: "'main'",
    what: 'abc1234',
    onTop: 0,
    pushed: { count: 2, remote: 'origin/main', canForce: true },
    moves: [],
    stays: [],
  };

  it('says what rewriting commits a remote has costs', () => {
    assert.equal(
      rewriteConfirmation(facts)?.detail,
      "Save the new message of abc1234?\n'origin/main' has 2 of them: pushing 'main' afterwards needs a force push, and anyone who fetched them keeps the old commits.\nUndo restores the original commits.",
    );
    assert.equal(
      rewriteConfirmation({ ...facts, pushed: { ...facts.pushed!, count: 1 } })?.detail,
      "Save the new message of abc1234?\n'origin/main' has one of them: pushing 'main' afterwards needs a force push, and anyone who fetched it keeps the old commit.\nUndo restores the original commits.",
    );
  });

  it('names the setting the force push afterwards needs while it is off', () => {
    assert.equal(
      rewriteConfirmation({ ...facts, pushed: { ...facts.pushed!, canForce: false } })?.detail,
      "Save the new message of abc1234?\n'origin/main' has 2 of them: pushing 'main' afterwards needs a force push, and anyone who fetched them keeps the old commits.\nForce pushes are off: the git.allowForcePush setting allows them.\nUndo restores the original commits.",
    );
  });
});

describe('reordering commits', () => {
  const facts: RewriteFacts = {
    edit: 'reorder',
    branch: "'feature/x'",
    what: '3 commits',
    onTop: 0,
    pushed: undefined,
    moves: [],
    stays: [],
  };

  it('asks only when commits were pushed, a ref is on them or changes are in the way', () => {
    assert.equal(rewriteConfirmation(facts), undefined);
    const pushed = rewriteConfirmation({ ...facts, pushed: { count: 2, remote: 'origin/feature/x', canForce: true } });
    assert.equal(pushed?.message, "Rewrite 2 commits that 'origin/feature/x' already has?");
    assert.equal(pushed.detail.split('\n')[0], "Reorder 3 commits on 'feature/x'?");
    assert.deepEqual(pushed.buttons, [{ id: 'only', label: 'Reorder Anyway' }]);
    const stays = rewriteConfirmation({ ...facts, stays: [{ name: 'wip', why: 'old' }] });
    assert.equal(stays?.message, "Reorder 3 commits on 'feature/x'?");
    assert.equal(stays.detail, "'wip' keeps the old commits.\nUndo restores the original commits.");
    assert.deepEqual(stays.buttons, [{ id: 'only', label: 'Reorder' }]);
  });

  it('says what it is doing, what it did and what Undo takes back', () => {
    assert.equal(REWRITE_DOING.reorder(3, "'feature/x'"), "Reordering 3 commits on 'feature/x'");
    assert.equal(REWRITE_DONE.reorder(3, "'feature/x'"), "Reordered 3 commits on 'feature/x'");
    assert.equal(undone(REWRITE_UNDO.reorder), 'Undid the reorder');
    assert.equal(rewriteInTheWay('reorder', '3 commits'), 'reorder of 3 commits');
  });

  it('says what the draft of the reorder mode does', () => {
    assert.equal(REORDER_MODE.lead('feature/x'), 'Reordering feature/x');
    assert.equal(REORDER_MODE.lead(undefined), 'Reordering HEAD');
    assert.equal(REORDER_MODE.moved(1), '1 commit moved.');
    assert.equal(REORDER_MODE.moved(2), '2 commits moved.');
    assert.equal(REORDER_MODE.mayConflict('src/a.ts', 1), 'May conflict in src/a.ts.');
    assert.equal(REORDER_MODE.mayConflict('src/a.ts', 2), 'May conflict in src/a.ts and 1 more file.');
    assert.equal(REORDER_MODE.mayConflict('src/a.ts', 3), 'May conflict in src/a.ts and 2 more files.');
    assert.equal(REORDER_MODE.pushed(1, 'origin/main'), 'Rewrites 1 commit already on origin/main.');
    assert.equal(REORDER_MODE.pushed(3, undefined), 'Rewrites 3 commits already on a remote.');
    assert.equal(REORDER_MODE.distance(-2), '↑2');
    assert.equal(REORDER_MODE.distance(1), '↓1');
    assert.equal(REORDER_MODE.distanceSpoken(-2), 'moved up 2 rows');
    assert.equal(REORDER_MODE.distanceSpoken(1), 'moved down 1 row');
  });

  it('says why nothing was reordered', () => {
    assert.equal(
      rewriteRefused('unchanged', 'abc1234', "'main'"),
      "The commits of 'main' are in that order already; nothing was reordered.",
    );
    assert.equal(reorderOutdated("'main'"), "'main' changed since the reorder started; nothing was reordered.");
    assert.equal(
      nothingToReorder("'main'"),
      "'main' has fewer than two commits above its last merge, so there is nothing to reorder.",
    );
  });
});
