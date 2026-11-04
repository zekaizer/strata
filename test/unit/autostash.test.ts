import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  leftoverOf,
  resolveStashChoices,
  settleMarks,
  type DirtyFacts,
  type StashMark,
} from '../../src/core/autostash.ts';
import type { OperationState } from '../../src/core/repo-state.ts';

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

describe('leftoverOf', () => {
  const stash = (index: number, message: string, branch: string | undefined = 'main') => ({
    hash: `${index}`.repeat(40),
    index,
    message,
    branch,
  });
  const base = { operation: undefined, unmerged: [], marks: [], headBranch: 'main' };
  const picking = (applying: string): OperationState => ({
    kind: 'cherryPick',
    branch: 'main',
    onto: undefined,
    step: undefined,
    applying,
    conflicts: ['a'],
    conflictCount: 1,
    empty: false,
    autostash: false,
  });
  const pushed = (hash: string, head?: string): StashMark => ({ kind: 'pushed', hash, ...(head ? { head } : {}) });

  it('names only the stash a stopped operation holds while it is in progress', () => {
    const stashes = [stash(0, 'On main: Strata autostash: cherry pick abc1234'), stash(1, 'On main: wip')];
    const held = { ...base, stashes, unmerged: ['a'], marks: [pushed(stashes[0]!.hash, 'c'.repeat(40))] };
    assert.deepEqual(leftoverOf({ ...held, operation: picking('c'.repeat(40)) }), {
      kind: 'pendingStash',
      stash: { hash: stashes[0]!.hash, index: 0 },
      operation: 'cherry pick',
    });
    assert.equal(leftoverOf({ ...held, operation: picking('d'.repeat(40)) }), undefined);
  });

  it('reports a restore Strata saw conflict, first, with its files', () => {
    const stashes = [stash(0, 'autostash'), stash(1, 'On main: Strata autostash: switch to x')];
    const marks: StashMark[] = [pushed(stashes[1]!.hash), { kind: 'restoreConflicted', hash: stashes[0]!.hash }];
    const l = leftoverOf({ ...base, stashes, unmerged: ['a.ts'], marks });
    assert.deepEqual(l, { kind: 'restoreConflicted', stash: { hash: stashes[0]!.hash, index: 0 }, files: ['a.ts'] });
  });

  it('reports a stash Strata pushed here and nobody restored, and no Strata-named stash it did not push', () => {
    const stashes = [
      stash(0, 'On main: Strata autostash: cherry pick 1234abc'),
      stash(1, 'On main: Strata autostash: cherry pick abc1234'),
    ];
    assert.deepEqual(leftoverOf({ ...base, stashes, marks: [pushed(stashes[1]!.hash)] }), {
      kind: 'pendingStash',
      stash: { hash: stashes[1]!.hash, index: 1 },
      operation: 'cherry pick',
    });
    assert.equal(leftoverOf({ ...base, stashes }), undefined);
  });

  it("reports unmerged files nobody resolves, naming git's own autostash without advising to drop it", () => {
    const stashes = [stash(0, 'On main: wip'), stash(1, 'autostash')];
    assert.deepEqual(leftoverOf({ ...base, stashes, unmerged: ['a.ts', 'b.ts'] }), {
      kind: 'unmerged',
      files: ['a.ts', 'b.ts'],
      count: 2,
      autostash: { hash: stashes[1]!.hash, index: 1 },
    });
  });

  it("names git's autostash only when it was made on this worktree's branch", () => {
    // refs/stash is shared by every worktree; an autostash made on another branch is another worktree's business.
    const stashes = [stash(0, 'autostash', 'feature')];
    assert.equal(leftoverOf({ ...base, stashes, unmerged: ['a.ts'] })?.kind, 'unmerged');
    assert.deepEqual(
      (leftoverOf({ ...base, stashes, unmerged: ['a.ts'] }) as { autostash: unknown }).autostash,
      undefined,
    );
    assert.deepEqual(
      (leftoverOf({ ...base, headBranch: 'feature', stashes, unmerged: ['a.ts'] }) as { autostash: unknown }).autostash,
      { hash: stashes[0]!.hash, index: 0 },
    );
  });
});

describe('settleMarks', () => {
  const op = (applying: string): OperationState => ({
    kind: 'revert',
    branch: 'main',
    onto: undefined,
    step: undefined,
    applying,
    conflicts: [],
    conflictCount: 0,
    empty: false,
    autostash: false,
  });
  const w = 'a'.repeat(40);
  const held: StashMark = { kind: 'pushed', hash: w, head: 'c'.repeat(40) };

  it('keeps the stash a stopped operation holds held while it is in progress', () => {
    assert.deepEqual(settleMarks([held], op('c'.repeat(40)), new Set([w])), [held]);
  });

  it('lets go of it once that operation ended without Strata, and forgets stashes that left the list', () => {
    const conflicted: StashMark = { kind: 'restoreConflicted', hash: 'b'.repeat(40) };
    assert.deepEqual(settleMarks([held, conflicted], undefined, new Set([w])), [{ kind: 'pushed', hash: w }]);
    assert.deepEqual(settleMarks([held], op('d'.repeat(40)), new Set([w])), [{ kind: 'pushed', hash: w }]);
  });
});
