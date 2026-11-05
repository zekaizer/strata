import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Leftover, OperationState } from '../../src/core/repo-state.ts';
import { bannerOf, type Banner, type BannerFacts } from '../../src/webview/banner.ts';

const h = (c: string) => c.repeat(40);
const SUBJECTS: Record<string, string> = { [h('a')]: 'Add lexer', [h('c')]: 'Fix parser' };
const NAMES: Record<string, string> = { [h('b')]: 'main', [h('d')]: 'topic' };
const facts = (hadConflicts = false): BannerFacts => ({
  subject: (x) => SUBJECTS[x],
  name: (x) => NAMES[x],
  hadConflicts,
});
const text = (b: Banner | undefined) => b?.parts.map((p) => (typeof p === 'string' ? p : p.short)).join('');
const actions = (b: Banner | undefined) => b?.actions.map((a) => [a.label, a.command, a.context ?? {}]);
const links = (b: Banner | undefined) => b?.parts.filter((p) => typeof p !== 'string');

const rebase: OperationState = {
  kind: 'rebase',
  branch: 'feature',
  onto: h('b'),
  step: { current: 3, total: 4 },
  applying: h('a'),
  conflicts: ['src/lexer.ts', 'src/token.ts'],
  conflictCount: 2,
  empty: false,
  autostash: true,
};
const merge: OperationState = {
  kind: 'merge',
  branch: 'main',
  onto: undefined,
  step: undefined,
  applying: h('d'),
  conflicts: ['a.txt'],
  conflictCount: 1,
  empty: false,
  autostash: true,
};
const pick: OperationState = { ...merge, kind: 'cherryPick', applying: h('c'), conflicts: ['p.ts'], autostash: false };
const stash = { hash: h('e'), index: 1 };
const showStash = ['Show Stash', 'strata.showStash', { strataHash: h('e') }];

describe('the banner of a stopped operation', () => {
  it('names a conflicted rebase stop, where its branch is, and where the stashed changes are', () => {
    const b = bannerOf(rebase, undefined, facts());
    assert.equal(b?.state, 'rebase');
    assert.equal(b.warning, true);
    assert.equal(b.label, 'Rebase in progress');
    assert.equal(
      text(b),
      `Rebasing 'feature' onto 'main' stopped at 3 of 4, "Add lexer" (aaaaaaa): 2 conflicted files. ` +
        "'feature' keeps its old commits until the rebase finishes. " +
        'Your uncommitted changes are held by git and come back when the rebase finishes or is aborted.',
    );
    assert.deepEqual(links(b), [{ short: 'aaaaaaa', hash: h('a') }]);
    assert.deepEqual(actions(b), [
      ['Resolve...', 'strata.resolveConflicts', {}],
      ['Continue', 'strata.operation.continue', {}],
      ['Skip...', 'strata.operation.skip', {}],
      ['Abort...', 'strata.operation.abort', {}],
    ]);
  });

  it('links a rebase target it cannot name, and leaves out a subject it does not know', () => {
    const b = bannerOf({ ...rebase, onto: h('f'), applying: h('9'), autostash: false }, undefined, facts());
    assert.equal(
      text(b),
      `Rebasing 'feature' onto fffffff stopped at 3 of 4 (9999999): 2 conflicted files. ` +
        "'feature' keeps its old commits until the rebase finishes.",
    );
    assert.deepEqual(links(b), [
      { short: 'fffffff', hash: h('f') },
      { short: '9999999', hash: h('9') },
    ]);
  });

  it('says what Continue does once the conflicts are resolved', () => {
    const resolved = { ...rebase, conflicts: [], conflictCount: 0 };
    const b = bannerOf(resolved, undefined, facts(true));
    assert.equal(b?.state, 'rebaseResolved');
    assert.equal(b.warning, false);
    assert.equal(text(b), 'Conflicts resolved. Continue finishes "Add lexer" and replays the remaining 1 commit.');
    assert.deepEqual(
      actions(b)?.map(([label]) => label),
      ['Continue', 'Skip...', 'Abort...'],
    );
    const last = { ...resolved, step: { current: 4, total: 4 } };
    assert.equal(
      text(bannerOf(last, undefined, facts(true))),
      'Conflicts resolved. Continue finishes "Add lexer" and completes the rebase.',
    );
  });

  it('claims no resolved conflicts for a stop that had none (edit, break, exec)', () => {
    const edit = { ...rebase, step: { current: 2, total: 4 }, conflicts: [], conflictCount: 0 };
    const b = bannerOf(edit, undefined, facts(false));
    assert.equal(b?.state, 'rebaseStopped');
    assert.equal(text(b), 'Rebase stopped at 2 of 4 ("Add lexer"). Continue replays the remaining 2 commits.');
    // git's --skip at an edit stop keeps the commit it already made.
    assert.deepEqual(
      actions(b)?.map(([label]) => label),
      ['Continue', 'Abort...'],
    );
  });

  it('names a stopped merge by its source and the branch it goes into', () => {
    const b = bannerOf(merge, undefined, facts());
    assert.equal(b?.label, 'Merge in progress');
    assert.equal(
      text(b),
      "Merging 'topic' into 'main': 1 conflicted file. " +
        'Your uncommitted changes are held by git and come back when the merge is committed or aborted.',
    );
    assert.deepEqual(actions(b), [
      ['Resolve...', 'strata.resolveConflicts', {}],
      ['Commit Merge', 'strata.operation.continue', {}],
      ['Abort...', 'strata.operation.abort', {}],
    ]);
    const resolved = bannerOf({ ...merge, conflicts: [], conflictCount: 0 }, undefined, facts(true));
    assert.equal(text(resolved), 'Conflicts resolved. Commit Merge records the merge.');
    assert.deepEqual(
      actions(resolved)?.map(([label]) => label),
      ['Commit Merge', 'Abort...'],
    );
  });

  it('offers only Skip and Abort for a cherry pick with nothing left to commit', () => {
    const b = bannerOf({ ...pick, conflicts: [], conflictCount: 0, empty: true }, undefined, facts());
    assert.equal(b?.state, 'sequencerEmpty');
    assert.equal(
      text(b),
      `Cherry picking ccccccc "Fix parser" onto 'main' has nothing left to commit: its changes are already there. Skip leaves it out.`,
    );
    assert.deepEqual(
      actions(b)?.map(([label]) => label),
      ['Skip...', 'Abort...'],
    );
  });

  it('offers Continue and Abort for a cherry pick or revert stopped between commits', () => {
    const between = { ...pick, applying: undefined, conflicts: [], conflictCount: 0, remaining: 2 };
    const b = bannerOf(between, undefined, facts());
    assert.equal(b?.state, 'sequencerBetween');
    assert.equal(b.warning, false);
    assert.equal(
      text(b),
      "Cherry picking onto 'main' stopped between commits. Continue cherry picks the remaining 2 commits.",
    );
    assert.deepEqual(
      actions(b)?.map(([label]) => label),
      ['Continue', 'Abort...'],
    );
    assert.equal(
      text(bannerOf({ ...between, kind: 'revert', remaining: 0 }, undefined, facts())),
      "Reverting on 'main' stopped between commits. Continue finishes the revert.",
    );
  });

  it("names a cherry pick's commit, and the stash Strata keeps its uncommitted changes in", () => {
    const pending: Leftover = { kind: 'pendingStash', stash: { hash: h('e'), index: 0 }, operation: 'cherry pick' };
    const b = bannerOf(pick, pending, facts());
    assert.equal(b?.state, 'sequencer');
    assert.equal(b.label, 'Cherry pick in progress');
    assert.equal(
      text(b),
      `Cherry picking ccccccc "Fix parser" onto 'main': 1 conflicted file. ` +
        'Your uncommitted changes are in stash@{0} (Strata autostash); Strata restores them when you continue or abort here.',
    );
    assert.deepEqual(
      actions(b)?.map(([label, command]) => [label, command]),
      [
        ['Resolve...', 'strata.resolveConflicts'],
        ['Continue', 'strata.operation.continue'],
        ['Skip...', 'strata.operation.skip'],
        ['Abort...', 'strata.operation.abort'],
      ],
    );
    const revert = bannerOf({ ...pick, kind: 'revert' }, undefined, facts());
    assert.equal(revert?.label, 'Revert in progress');
    assert.equal(text(revert), `Reverting ccccccc "Fix parser" on 'main': 1 conflicted file.`);
  });

  it('shows the operation in progress before anything left behind', () => {
    const left: Leftover = { kind: 'restoreConflicted', stash, files: ['x'] };
    assert.equal(bannerOf(rebase, left, facts())?.state, 'rebase');
  });
});

describe('the banner of what an operation left behind', () => {
  it('says where conflicted stashed changes are, and offers to show the stash', () => {
    const b = bannerOf(undefined, { kind: 'restoreConflicted', stash, files: ['src/lexer.ts'] }, facts());
    assert.equal(b?.state, 'leftover');
    assert.equal(b.warning, true);
    assert.equal(b.label, 'Stashed changes');
    assert.equal(text(b), "Restoring your stashed changes conflicted in src/lexer.ts. They're safe in stash@{1}.");
    assert.deepEqual(actions(b), [['Resolve...', 'strata.resolveConflicts', {}], showStash]);
  });

  it('asks to drop or keep the stash once its conflicts are resolved', () => {
    const b = bannerOf(undefined, { kind: 'restoreConflicted', stash, files: [] }, facts());
    assert.equal(b?.state, 'leftoverResolved');
    assert.equal(text(b), 'Conflicts resolved. If all your changes are back, drop stash@{1}.');
    assert.deepEqual(actions(b), [
      ['Drop Stash...', 'strata.stash.drop', { strataHash: h('e') }],
      ['Keep It', 'strata.keepStash', { strataHash: h('e') }],
    ]);
  });

  it('asks to restore a Strata stash that an operation finished elsewhere left behind', () => {
    const b = bannerOf(undefined, { kind: 'pendingStash', stash, operation: 'revert' }, facts());
    assert.equal(b?.state, 'pending');
    assert.equal(text(b), "Strata stashed your changes before a revert and hasn't restored them: stash@{1}.");
    assert.deepEqual(actions(b), [
      ['Pop Stash', 'strata.stash.pop', { strataHash: h('e') }],
      ['Keep in Stash', 'strata.keepStash', { strataHash: h('e') }],
    ]);
    const undo = bannerOf(undefined, { kind: 'pendingStash', stash, operation: 'undo' }, facts());
    assert.match(text(undo) ?? '', /before an undo /);
  });

  it('counts unmerged files nobody is resolving, and names the stash git kept', () => {
    const b = bannerOf(undefined, { kind: 'unmerged', files: ['a', 'b'], count: 2, autostash: stash }, facts());
    assert.equal(b?.state, 'conflicts');
    assert.equal(text(b), '2 files have conflicts. git kept stashed changes in stash@{1} (autostash).');
    assert.deepEqual(actions(b), [['Resolve...', 'strata.resolveConflicts', {}], showStash]);
    const one = bannerOf(undefined, { kind: 'unmerged', files: ['a'], count: 1, autostash: undefined }, facts());
    assert.equal(text(one), '1 file has conflicts.');
    assert.deepEqual(
      actions(one)?.map(([label]) => label),
      ['Resolve...'],
    );
  });

  it('is absent with nothing in progress or left behind', () => {
    assert.equal(bannerOf(undefined, undefined, facts()), undefined);
  });
});
