import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveStashChoices } from '../../src/core/autostash.ts';
import {
  abortConfirmation,
  deleteBranchConfirmation,
  dirtySection,
  fileList,
  resetConfirmation,
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
    const dirty = { files: 3, staged: 1, overlap: false };
    const s = dirtySection(dirty, resolveStashChoices('merge', dirty, 'gitConfig', true), 0);
    assert.equal(
      s,
      'Uncommitted changes: 3 files (1 staged). merge.autoStash is on. Untracked files are not stashed; they stay in place.',
    );
    assert.match(
      dirtySection(dirty, resolveStashChoices('merge', dirty, 'gitConfig', true), 2),
      /2 submodules are not stashed/,
    );
  });

  const reset: ResetFacts = {
    branch: 'main',
    target: c('a1b2c3d', 'Base'),
    dropped: [c('1111111', 'Two'), c('2222222', 'One')],
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
      '\'main\' moves back 2 commits: "Two" and "One". 2 of them are on no other branch; Undo or the reflog can restore them. Their changes stay in your files, unstaged.',
    );
    assert.deepEqual(r.buttons, [{ id: 'reset', label: "Reset 'main'" }]);
  });

  it('warns about discarded work on a hard reset and about the upstream', () => {
    const r = resetConfirmation(
      { ...reset, dropped: [c('1111111', 'Two')], onUpstream: 1, unreachable: 0, dirtyFiles: 4 },
      'hard',
    );
    assert.match(r!.detail, /1 of them is on origin\/main; 'main' will be 1 behind it \(a pull brings it back\)\./);
    assert.match(r!.detail, /Their changes and your uncommitted changes in 4 files are discarded\./);
  });

  it('asks nothing for a reset that drops nothing and discards nothing', () => {
    assert.equal(resetConfirmation({ ...reset, dropped: [], unreachable: 0 }, 'soft'), undefined);
    assert.ok(resetConfirmation({ ...reset, dropped: [], unreachable: 0, dirtyFiles: 1 }, 'hard'));
  });

  it('says when deleting a branch loses commits', () => {
    const safe = deleteBranchConfirmation('topic', c('abc1234', 'Tip'), [], 'origin/topic');
    assert.equal(safe.message, "Delete branch 'topic'?");
    assert.equal(
      safe.detail,
      'It points at abc1234 "Tip", which is also on another branch. No commits are lost. The remote branch origin/topic is not deleted.',
    );
    const lossy = deleteBranchConfirmation(
      'topic',
      c('abc1234', 'Tip'),
      [c('abc1234', 'Tip'), c('def5678', 'Older')],
      undefined,
    );
    assert.equal(lossy.message, "Delete branch 'topic' and its 2 unmerged commits?");
    assert.match(lossy.detail, /^2 commits would be on no branch, newest "Tip" \(abc1234\)\./);
    assert.deepEqual(lossy.buttons, [{ id: 'delete', label: 'Delete Branch and Commits' }]);
  });

  it('says what aborting gives back', () => {
    const a = abortConfirmation('rebase', 'topic', '9f8e7d6', true);
    assert.equal(a.message, 'Abort the rebase?');
    assert.equal(
      a.detail,
      "'topic' goes back to 9f8e7d6 as before the rebase. Conflict resolutions you've made are discarded. Your stashed changes are restored.",
    );
    assert.deepEqual(a.buttons, [{ id: 'abort', label: 'Abort Rebase' }]);
    assert.match(
      abortConfirmation('cherryPick', undefined, '9f8e7d6', false).detail,
      /^HEAD goes back to 9f8e7d6 as before the cherry pick\./,
    );
  });
});
