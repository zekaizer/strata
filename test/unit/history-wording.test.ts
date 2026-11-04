import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveStashChoices } from '../../src/core/autostash.ts';
import {
  conflictsInProgress,
  dirtySection,
  HISTORY_DONE,
  mergeConfirmation,
  operationInProgress,
  pickConfirmation,
  popPartial,
  popRefused,
  rebaseConfirmation,
  resetPick,
  shallowConfirmation,
  skipConfirmation,
  stillConflicted,
  stoppedMessage,
} from '../../src/core/wording.ts';

const labels = (b: { label: string }[]) => b.map((x) => x.label);
const c = { short: 'abc1234', subject: 'Add lexer' };

describe('wording of history operations', () => {
  const merge = { src: "'topic'", into: "'main'", short: 'abc1234', count: 2, canFastForward: true };

  it('offers fast-forward or a merge commit, merge commit first when merge.ff is false', () => {
    const ff = mergeConfirmation(merge, undefined);
    assert.equal(ff.message, "Merge 'topic' into 'main'?");
    assert.equal(ff.detail, "'main' can fast-forward to abc1234 (2 commits), or record a merge commit.");
    assert.deepEqual(labels(ff.buttons), ['Fast-Forward', 'Create Merge Commit']);
    assert.deepEqual(labels(mergeConfirmation(merge, false).buttons), ['Create Merge Commit', 'Fast-Forward']);
    const diverged = mergeConfirmation({ ...merge, canFastForward: false }, undefined);
    assert.equal(diverged.detail, "Creates a merge commit on 'main' with 2 commits from 'topic'.");
    assert.deepEqual(labels(diverged.buttons), ['Merge']);
  });

  it('says how a merge with uncommitted changes records the result, and asks about the changes', () => {
    const d = mergeConfirmation(merge, undefined, {
      section: 'Uncommitted changes: 1 file.',
      buttons: [{ id: 'stash', label: 'Stash & Merge' }],
      mode: 'ff',
    });
    assert.equal(d.detail, "'main' fast-forwards to abc1234 (2 commits). Uncommitted changes: 1 file.");
    assert.deepEqual(labels(d.buttons), ['Stash & Merge']);
  });

  it('says what a rebase replays and drops', () => {
    const r = rebaseConfirmation(
      {
        branch: "'feature'",
        onto: "'main'",
        ontoShort: 'e4f5a6b',
        replay: 4,
        merges: 1,
        onUpstream: 2,
        upstream: 'origin/feature',
      },
      '',
      [{ id: 'rebase', label: 'Rebase' }],
    );
    assert.equal(r.message, "Rebase 'feature' onto 'main'?");
    assert.equal(
      r.detail,
      "Replays 4 commits of 'feature' on top of 'main' (e4f5a6b). 1 merge commit is dropped; the commits they brought in are replayed one by one. 2 of them are on origin/feature: you'll need to force push afterwards. Undo restores the original commits.",
    );
  });

  it('warns that a pick on a detached HEAD lands on no branch', () => {
    const p = pickConfirmation('cherryPick', c, 'HEAD', true, '', [{ id: 'go', label: 'Cherry Pick' }]);
    assert.equal(p.message, 'Cherry pick abc1234 "Add lexer" onto HEAD?');
    assert.equal(p.detail, 'HEAD is detached: the new commit will be on no branch.');
    assert.equal(
      pickConfirmation('revert', c, "'main'", false, 'x', []).message,
      'Revert abc1234 "Add lexer" on \'main\'?',
    );
  });

  it('says where a stopped operation is and where the changes are', () => {
    assert.equal(
      stoppedMessage('rebase', { current: 3, total: 4 }, 'Add lexer', ['a.ts', 'b.ts'], 2, undefined),
      'Rebase stopped at 3 of 4 ("Add lexer") with conflicts in 2 files (a.ts and b.ts).',
    );
    assert.equal(
      stoppedMessage(
        'cherryPick',
        undefined,
        undefined,
        ['a.ts'],
        1,
        'stash@{0} ("On main: Strata autostash: cherry pick abc1234")',
      ),
      'Cherry pick stopped with conflicts in 1 file (a.ts). Your uncommitted changes are in stash@{0} ("On main: Strata autostash: cherry pick abc1234").',
    );
    assert.equal(stillConflicted(['a.ts'], 1).message, '1 file still has conflicts: a.ts.');
    assert.equal(skipConfirmation(c, "'main'").detail, "Its changes won't be in 'main'.");
  });

  it('explains why other writes wait', () => {
    const r = operationInProgress('rebase', { current: 2, total: 5 });
    assert.equal(r.message, 'A rebase is in progress (stopped at 2 of 5).');
    assert.deepEqual(labels(r.buttons), ['Continue', 'Abort Rebase...']);
    assert.equal(operationInProgress('merge', undefined).message, 'A merge is in progress.');
    assert.equal(conflictsInProgress(['a.ts', 'b.ts'], 2).message, '2 files have unresolved conflicts: a.ts and b.ts.');
    assert.match(shallowConfirmation("'main'", "'topic'").message, /^This clone is shallow/);
  });

  it('names the untracked files a hard reset would overwrite instead of claiming they stay', () => {
    const dirty = { files: 1, staged: 0, overlap: false };
    const choices = resolveStashChoices('resetHard', dirty, 'gitConfig', undefined);
    assert.equal(
      dirtySection(dirty, choices, 0, ['parser.ts']),
      'Uncommitted changes: 1 file. A hard reset discards uncommitted changes; stashing first keeps them in the stash list. 1 untracked file at paths the reset restores would be overwritten (parser.ts); stashing takes them too.',
    );
    assert.doesNotMatch(dirtySection(dirty, choices, 0, []), /stay in place/);
    assert.deepEqual(resetPick("'main'", c, 2), {
      title: 'Reset \'main\' to abc1234 "Add lexer"',
      placeholder: "2 commits leave 'main'. What happens to their changes?",
    });
  });

  it('says what was done', () => {
    assert.equal(HISTORY_DONE.rebased("'feature'", "'main'", 4), "Rebased 'feature' onto 'main' (4 commits)");
    assert.equal(
      HISTORY_DONE.reset("'main'", 'abc1234', 'stash@{0} ("x")'),
      'Reset \'main\' to abc1234. Your uncommitted changes are in stash@{0} ("x")',
    );
    assert.equal(HISTORY_DONE.aborted('cherryPick'), 'Aborted the cherry pick');
  });

  it('says when restoring stashed changes only partly worked, or not at all', () => {
    assert.equal(
      popPartial("Merged 'topic' into 'main'", 'stash@{0} ("On main: x")'),
      "Merged 'topic' into 'main', but only part of your stashed changes came back (git could not restore some files). The rest is safe in stash@{0} (\"On main: x\").",
    );
    assert.equal(
      popRefused("Switched to 'x'", 'your local changes would be overwritten.', 'stash@{1} ("y")'),
      "Switched to 'x', but git could not restore your stashed changes: your local changes would be overwritten. They're safe in stash@{1} (\"y\").",
    );
  });
});
