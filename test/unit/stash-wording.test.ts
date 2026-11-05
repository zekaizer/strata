import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  dropStashConfirmation,
  NOTHING_TO_STASH,
  STASH_DONE,
  stashBranchDirty,
  stashBranchInput,
  stashConflicted,
  stashPartial,
  stashPushInput,
} from '../../src/core/wording.ts';

describe('wording of stash operations', () => {
  it('says what a stash push takes', () => {
    assert.equal(NOTHING_TO_STASH, 'No local changes to stash.');
    assert.deepEqual(stashPushInput(3, 1, false), {
      title: 'Stash Changes',
      prompt: 'Message (optional). Stashes 3 changed files (1 staged).',
    });
    assert.equal(stashPushInput(1, 0, true).prompt, 'Message (optional). Stashes 1 changed file and untracked files.');
    assert.equal(stashPushInput(0, 0, true).prompt, 'Message (optional). Stashes untracked files.');
  });

  it('says an Apply or Pop that did not fully restore the stash applied it, and whether the stash was kept', () => {
    assert.equal(
      stashConflicted('stash@{0} ("x")', ['src/a.ts'], true),
      'Applied stash@{0} ("x") with conflicts in src/a.ts; the stash was kept.',
    );
    assert.equal(
      stashConflicted('stash@{0} ("x")', ['src/a.ts'], false),
      'Applied stash@{0} ("x") with conflicts in src/a.ts.',
    );
    assert.equal(
      stashPartial('stash@{0} ("x")', true),
      'Applied part of stash@{0} ("x"): git could not restore some files; the stash was kept.',
    );
  });

  it('says what dropping a stash loses and how Undo brings it back', () => {
    const d = dropStashConfirmation(
      2,
      'On main: wip',
      { changed: 3, untracked: 1 },
      { short: 'abc1234', subject: 'Base' },
    );
    assert.equal(d.message, 'Drop stash "wip"?');
    assert.equal(
      d.detail,
      '3 changed files and 1 untracked on abc1234 "Base".\nUndo brings it back; after that Strata can\'t.',
    );
    assert.deepEqual(d.buttons, [{ id: 'drop', label: 'Drop Stash' }]);
    assert.match(dropStashConfirmation(0, 'x', undefined, { short: 'a', subject: 'b' }).detail, /^Made on a "b"\./);
  });

  it('says that creating a branch from a stash removes it from the list', () => {
    assert.deepEqual(stashBranchInput(1, 'On main: wip', 'abc1234'), {
      title: 'Create Branch from stash "wip"',
      prompt:
        'Creates the branch at abc1234, switches to it, restores the stash there and removes it from the stash list.',
    });
    assert.equal(
      stashBranchDirty('abc1234'),
      'Commit or stash your uncommitted changes first: the branch starts at abc1234.',
    );
  });

  it('says what was done', () => {
    assert.equal(STASH_DONE.stashed(2, 'stash@{0} ("On main: x")'), 'Stashed 2 files as stash@{0} ("On main: x")');
    assert.equal(STASH_DONE.popped('stash@{1} ("y")'), 'Popped stash@{1} ("y")');
    assert.equal(STASH_DONE.branched('x', 'stash@{0} ("y")'), 'Created \'x\' from stash@{0} ("y") and applied it');
  });
});
