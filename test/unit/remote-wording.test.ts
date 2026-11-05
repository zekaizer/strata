import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  deleteRemoteBranchConfirmation,
  divergedConfirmation,
  forcePushConfirmation,
  NO_REMOTE,
  noUpstream,
  pushOtherNameConfirmation,
  pushRejectedConfirmation,
  pushTagPick,
  REMOTE_DONE,
  tagExistsOnRemote,
} from '../../src/core/wording.ts';

describe('wording of remote operations', () => {
  it('asks how to pull a branch that diverged, saying what config limits', () => {
    const d = divergedConfirmation("'main'", 'origin/main', 2, 3, { rebase: true, merge: true }, undefined);
    assert.equal(d.message, "'main' and 'origin/main' have diverged (2 and 3 commits).");
    assert.deepEqual(
      d.buttons.map((b) => b.label),
      ['Rebase', 'Merge'],
    );
    const ffOnly = divergedConfirmation(
      "'main'",
      'origin/main',
      1,
      1,
      { rebase: true, merge: false },
      'pull.ff is "only", so git would not merge.',
    );
    assert.deepEqual(
      ffOnly.buttons.map((b) => b.label),
      ['Rebase'],
    );
    assert.equal(ffOnly.detail, 'pull.ff is "only", so git would not merge.');
    assert.equal(noUpstream('topic'), "'topic' has no upstream branch.");
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
    assert.equal(r.message, "'origin/x' has 2 commits that 'x' doesn't have.");
    assert.equal(r.detail, 'Pull them first, or overwrite them with a force push.');
    assert.deepEqual(
      r.buttons.map((b) => b.label),
      ['Pull', 'Force Push (With Lease)...'],
    );
    assert.deepEqual(pushRejectedConfirmation('origin/x', 'x', 1, false, false).buttons, []);
    const f = forcePushConfirmation('x', 'origin', 'origin/x', 2, 'Their fix');
    assert.equal(f.message, "Force push 'x' to 'origin'?");
    assert.equal(
      f.detail,
      "Replaces origin/x, which has 2 commits 'x' doesn't have (newest \"Their fix\"). The push fails if origin/x changed since Strata read it.",
    );
  });

  it('confirms deleting a remote branch with the commits it would leave on no ref', () => {
    const tip = { short: 'abc1234', subject: 'Fix' };
    assert.deepEqual(deleteRemoteBranchConfirmation('origin', 'x', 'origin/x', tip, [], [], false), {
      message: "Delete branch 'x' from 'origin'?",
      detail:
        "'origin/x' points at abc1234 \"Fix\", which is also on another branch or tag. No commits are lost. Strata can't undo this.",
      buttons: [{ id: 'delete', label: 'Delete Remote Branch' }],
    });
    const lost = deleteRemoteBranchConfirmation('origin', 'x', 'origin/x', tip, [tip, tip], ['x', 'y'], true);
    assert.equal(lost.message, "Delete branch 'x' from 'origin' and its 2 unmerged commits?");
    assert.equal(
      lost.detail,
      "'origin/x' changed on 'origin' since the last fetch. 2 commits would be on no branch, newest \"Fix\" (abc1234). Local branches 'x' and 'y' track it and stay. Strata can't undo this.",
    );
    assert.deepEqual(lost.buttons, [{ id: 'delete', label: 'Delete Remote Branch and Commits' }]);
    assert.match(
      deleteRemoteBranchConfirmation('origin', 'x', 'origin/x', tip, [], ['x'], false).detail,
      / Local branch 'x' tracks it and stays\. /,
    );
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
    assert.equal(REMOTE_DONE.remoteBranchDeleted('x', 'origin'), "Deleted branch 'x' from origin");
    assert.equal(REMOTE_DONE.remoteBranchGone('origin/x', 'origin'), "'origin/x' was already gone from origin");
  });
});
