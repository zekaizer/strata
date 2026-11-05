import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  deleteRemoteBranchConfirmation,
  deleteRemoteTagConfirmation,
  deleteRemoteTagPick,
  divergedConfirmation,
  forcePushConfirmation,
  NO_REMOTE,
  noUpstream,
  pushOtherNameConfirmation,
  pushRejectedConfirmation,
  pushRejectedNotice,
  pushTagPick,
  PULL_NOTES,
  REMOTE_DONE,
  tagExistsOnRemote,
  upstreamGone,
} from '../../src/core/wording.ts';

describe('wording of remote operations', () => {
  it('asks how to pull a branch that diverged, saying what config limits', () => {
    const both = [
      { id: 'rebase', label: 'Rebase' },
      { id: 'merge', label: 'Merge' },
    ];
    const d = divergedConfirmation("'main'", 'origin/main', 2, 3, both, undefined);
    assert.equal(d.message, "'main' has 2 commits 'origin/main' lacks and is 3 behind.");
    assert.equal(d.detail, '');
    assert.deepEqual(
      d.buttons.map((b) => b.label),
      ['Rebase', 'Merge'],
    );
    const ffOnly = divergedConfirmation(
      "'main'",
      'origin/main',
      1,
      1,
      [{ id: 'rebase', label: 'Rebase' }],
      PULL_NOTES.ffOnly,
      'Uncommitted changes in 1 file; untracked files stay in place.',
    );
    assert.deepEqual(
      ffOnly.buttons.map((b) => b.label),
      ['Rebase'],
    );
    assert.equal(
      ffOnly.detail,
      'Merging needs pull.ff other than "only".\nUncommitted changes in 1 file; untracked files stay in place.',
    );
    assert.equal(noUpstream('topic'), "'topic' has no upstream branch.");
    assert.equal(
      upstreamGone('topic', 'origin/topic'),
      "'origin/topic', the upstream of 'topic', is gone from its remote. Publish the branch again, or unset its upstream.",
    );
    assert.equal(NO_REMOTE, 'This repository has no remote.');
  });

  it('confirms a push to an upstream of another name, offering a branch of its own first', () => {
    const c = pushOtherNameConfirmation('feature', 'origin', 'main');
    assert.equal(c.message, "'feature' tracks origin/main, which has another name.");
    assert.deepEqual(c.buttons, [
      { id: 'new', label: "Push to new 'origin/feature'" },
      { id: 'upstream', label: "Push to 'origin/main'" },
    ]);
  });

  it('says what a rejected push would overwrite', () => {
    const r = pushRejectedConfirmation('origin/x', 'x', 2, true, true);
    assert.ok(r);
    assert.equal(r.message, "'origin/x' has 2 commits that 'x' doesn't have.");
    assert.equal(
      r.detail,
      "Pulling brings them into 'x', then you can push.\nA force push removes them from 'origin/x'.",
    );
    assert.deepEqual(
      r.buttons.map((b) => b.label),
      ['Pull', 'Force Push (With Lease)...'],
    );
    assert.equal(
      pushRejectedConfirmation('origin/x', 'x', 1, false, true)?.detail,
      "A force push removes it from 'origin/x'.",
    );
    assert.equal(
      pushRejectedConfirmation('origin/x', 'x', 1, true, false)?.detail,
      "Pulling brings it into 'x', then you can push.",
    );
    assert.equal(pushRejectedConfirmation('origin/x', 'x', 1, false, false), undefined);
    assert.equal(
      pushRejectedNotice('origin/x', 'x', 1),
      "'origin/x' has 1 commit that 'x' doesn't have. Switch to 'x' and pull it first.",
    );
    const f = forcePushConfirmation('x', 'origin', 'origin/x', 2, 'Their fix');
    assert.equal(f.message, "Force push 'x' to 'origin'?");
    assert.equal(
      f.detail,
      "Removes 2 commits 'x' doesn't have from origin/x, newest \"Their fix\".\nStrata can't undo this.\nNothing is pushed if origin/x changed since Strata read it.",
    );
  });

  it('confirms deleting a remote branch with the commits it would leave on no ref', () => {
    const tip = { short: 'abc1234', subject: 'Fix' };
    assert.deepEqual(deleteRemoteBranchConfirmation('origin', 'x', 'origin/x', tip, [], [], false), {
      message: "Delete branch 'x' from 'origin'?",
      detail: "'origin/x' points at abc1234 \"Fix\", which another branch or tag has too.\nStrata can't undo this.",
      buttons: [{ id: 'delete', label: 'Delete Remote Branch' }],
    });
    const lost = deleteRemoteBranchConfirmation('origin', 'x', 'origin/x', tip, [tip, tip], ['x', 'y'], true);
    assert.equal(lost.message, "Delete branch 'x' from 'origin' and its 2 unmerged commits?");
    assert.equal(
      lost.detail,
      "'origin/x' changed on 'origin' since the last fetch. 2 commits would be on no branch, newest \"Fix\" (abc1234).\nStrata can't undo this.\nLocal branches 'x' and 'y' track it and stay.",
    );
    assert.deepEqual(lost.buttons, [{ id: 'delete', label: 'Delete Remote Branch and Commits' }]);
    assert.match(
      deleteRemoteBranchConfirmation('origin', 'x', 'origin/x', tip, [], ['x'], false).detail,
      /\nLocal branch 'x' tracks it and stays\.$/,
    );
  });

  it('confirms deleting a tag from a remote, keeping the local one', () => {
    assert.equal(deleteRemoteTagPick('v1'), "Delete tag 'v1' from…");
    assert.deepEqual(deleteRemoteTagConfirmation('v1', 'origin', { short: 'abc1234', subject: 'Release' }), {
      message: "Delete tag 'v1' from 'origin'?",
      detail: 'The local tag stays at abc1234 "Release".\nStrata can\'t undo this.',
      buttons: [{ id: 'delete', label: 'Delete Tag from Remote' }],
    });
  });

  it('says what was done', () => {
    assert.equal(REMOTE_DONE.fetched(undefined), 'Fetched all remotes');
    assert.equal(REMOTE_DONE.fetched('origin'), 'Fetched origin');
    assert.equal(REMOTE_DONE.published('x', 'origin'), "Published 'x' to origin");
    assert.equal(REMOTE_DONE.pushed('x', 'origin/x'), "Pushed 'x' to origin/x");
    assert.equal(REMOTE_DONE.upToDate, 'Already up to date');
    assert.equal(pushTagPick('v1'), "Push tag 'v1' to…");
    assert.equal(REMOTE_DONE.tagPushed('v1', 'origin'), "Pushed tag 'v1' to origin");
    assert.equal(tagExistsOnRemote('v1', 'origin'), "'origin' already has a different tag 'v1'; nothing was pushed.");
    assert.equal(REMOTE_DONE.remoteTagDeleted('v1', 'origin'), "Deleted tag 'v1' from origin");
    assert.equal(REMOTE_DONE.remoteBranchDeleted('x', 'origin'), "Deleted branch 'x' from origin");
    assert.equal(REMOTE_DONE.remoteBranchGone('origin/x', 'origin'), "'origin/x' was already gone from origin");
  });
});
