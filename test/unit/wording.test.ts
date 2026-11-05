import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  abortConfirmation,
  commandUnquotable,
  deleteBranchConfirmation,
  dirtySection,
  fileList,
  gitFailure,
  gitTooOld,
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
      '\'main\' moves back 1 commit ("Two"); their changes are discarded.\nUndo brings it back (1 also on origin/main).',
    );
    const partly = resetConfirmation({ ...reset, onUpstream: 1, unreachable: 1 }, 'keep');
    assert.match(
      partly!.detail,
      /\nUndo brings them back \(1 on no other branch; 1 also on origin\/main\)\.\nYour uncommitted changes stay\.$/,
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
    assert.match(lossy.detail, /^2 commits would be on no branch, newest "Tip" \(abc1234\)\./);
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

  it("shows the first three lines of git's message", () => {
    assert.equal(gitFailure('error: one\nhint: two\nhint: three\nhint: four\n'), 'error: one\nhint: two\nhint: three');
    assert.equal(gitFailure('  fatal: bad\n'), 'fatal: bad');
  });

  it('hands a failed sign-in to a terminal', () => {
    const auth = signInConfirmation('origin', 'auth');
    assert.equal(auth.message, "Strata couldn't sign in to 'origin'.");
    assert.equal(
      auth.detail,
      'git needs credentials, and no credential helper or SSH agent provided them. Run the same command in a terminal to sign in there.',
    );
    assert.deepEqual(
      auth.buttons.map((b) => b.label),
      ['Run in Terminal', 'Show Output'],
    );
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
    assert.equal(gitTooOld('2.25.1'), 'Strata needs git 2.27 or newer to change repositories (found 2.25.1).');
  });
});
