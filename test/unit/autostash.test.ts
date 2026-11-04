import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveStashChoices, type DirtyFacts } from '../../src/core/autostash.ts';

const clean: DirtyFacts = { files: 0, staged: 0, overlap: false };
const dirty: DirtyFacts = { files: 2, staged: 0, overlap: false };
const staged: DirtyFacts = { files: 2, staged: 1, overlap: false };
const overlapping: DirtyFacts = { files: 2, staged: 0, overlap: true };
const off = false;
const on = true;

describe('resolveStashChoices', () => {
  it('asks nothing when the worktree is clean', () => {
    for (const op of ['rebase', 'merge', 'cherryPick', 'switch', 'resetHard'] as const)
      assert.deepEqual(resolveStashChoices(op, clean, 'always', on).choices, [], op);
  });

  it('offers only stashing where git refuses to run with changes', () => {
    const rebase = resolveStashChoices('rebase', dirty, 'never', off);
    assert.deepEqual(rebase.choices, ['stash']);
    assert.equal(rebase.mechanism, 'git');
    assert.match(rebase.explain, /git can't rebase with uncommitted changes/);
    assert.deepEqual(resolveStashChoices('pullRebase', dirty, 'never', off).choices, ['stash']);
    assert.deepEqual(resolveStashChoices('cherryPick', staged, 'never', off).choices, ['stash']);
  });

  it('follows git config for merge unless the setting overrides it, and says so', () => {
    const fromGit = resolveStashChoices('merge', dirty, 'gitConfig', on);
    assert.deepEqual(fromGit.choices, ['stash', 'keep']);
    assert.match(fromGit.explain, /merge\.autoStash is on/);
    const keep = resolveStashChoices('merge', dirty, 'gitConfig', off);
    assert.deepEqual(keep.choices, ['keep', 'stash']);
    assert.match(keep.explain, /merge\.autoStash is off/);
    const unset = resolveStashChoices('merge', dirty, 'gitConfig', undefined);
    assert.deepEqual(unset.choices, ['stash', 'keep'], 'git warns about a merge over changes when it is unset');
    assert.equal(unset.explain, 'merge.autoStash is not set.');
    const never = resolveStashChoices('merge', dirty, 'never', on);
    assert.deepEqual(never.choices, ['keep', 'stash']);
    assert.match(never.explain, /strata\.autoStash is "never"/);
    assert.deepEqual(resolveStashChoices('pullMerge', dirty, 'always', off).choices, ['stash', 'keep']);
  });

  it('stashes explicitly where git has no --autostash', () => {
    assert.equal(resolveStashChoices('merge', dirty, 'always', off).mechanism, 'git');
    const pick = resolveStashChoices('cherryPick', dirty, 'gitConfig', on);
    assert.deepEqual(pick.choices, ['keep', 'stash']);
    assert.equal(pick.mechanism, 'explicit');
    assert.deepEqual(resolveStashChoices('revert', dirty, 'always', off).choices, ['stash', 'keep']);
  });

  it('lets git carry changes on a switch unless they overlap the target', () => {
    assert.deepEqual(resolveStashChoices('switch', dirty, 'always', on).choices, []);
    assert.deepEqual(resolveStashChoices('switch', overlapping, 'gitConfig', off).choices, ['stash', 'migrate']);
    assert.deepEqual(resolveStashChoices('switch', overlapping, 'never', off).choices, ['migrate', 'stash']);
  });

  it('keeps a safety stash before a hard reset, never popped, offered first whatever the setting', () => {
    const hard = resolveStashChoices('resetHard', dirty, 'never', off);
    assert.deepEqual(hard.choices, ['stash', 'discard']);
    assert.equal(hard.mechanism, 'safety');
    assert.deepEqual(resolveStashChoices('resetKeep', dirty, 'never', off).choices, []);
    assert.deepEqual(resolveStashChoices('resetKeep', overlapping, 'never', off).choices, ['stash']);
  });
});
