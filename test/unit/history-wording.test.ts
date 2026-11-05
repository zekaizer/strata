import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveStashChoices } from '../../src/core/autostash.ts';
import {
  conflictsInProgress,
  dirtySection,
  alreadyReverted,
  HISTORY_DONE,
  mainlinePick,
  mergeAnswer,
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
  type MergeFacts,
  unstagedResolutions,
} from '../../src/core/wording.ts';

const labels = (b: { label: string }[]) => b.map((x) => x.label);
const c = { short: 'abc1234', subject: 'Add lexer' };

describe('wording of history operations', () => {
  const merge: MergeFacts = {
    op: 'merge',
    src: "'topic'",
    into: "'main'",
    short: 'abc1234',
    count: 2,
    canFastForward: true,
  };

  it('offers fast-forward or a merge commit, merge commit first when merge.ff is false', () => {
    const ff = mergeConfirmation(merge, undefined);
    assert.equal(ff.message, "Merge 'topic' into 'main'?");
    assert.equal(ff.detail, "'main' can fast-forward to abc1234 (2 commits), or record a merge commit.");
    assert.deepEqual(labels(ff.buttons), ['Fast-Forward', 'Create Merge Commit']);
    assert.deepEqual(labels(mergeConfirmation(merge, false).buttons), ['Create Merge Commit', 'Fast-Forward']);
  });

  it('says how a merge with uncommitted changes records the result, and asks about the changes', () => {
    const d = mergeConfirmation({ ...merge, canFastForward: false }, undefined, {
      section: 'Uncommitted changes: 1 file.',
      modes: [{ mode: 'ff', choices: ['stash', 'keep'] }],
    });
    assert.equal(
      d.detail,
      "Creates a merge commit on 'main' with 2 commits from 'topic'. Uncommitted changes: 1 file.",
    );
    assert.deepEqual(labels(d.buttons), ['Stash & Merge', 'Merge Keeping Changes']);
    assert.deepEqual(mergeAnswer(d.buttons[1]!.id), { mode: 'ff', choice: 'keep' });
    const pull = mergeConfirmation(merge, undefined, {
      section: 'Uncommitted changes: 1 file.',
      modes: [{ mode: 'ff', choices: ['stash'] }],
    });
    assert.equal(pull.detail, "'main' fast-forwards to abc1234 (2 commits). Uncommitted changes: 1 file.");
  });

  it('calls the merge or rebase of a pull Pull', () => {
    const dirty = { section: '', modes: [{ mode: 'ff' as const, choices: ['stash' as const] }] };
    const pull = mergeConfirmation({ ...merge, op: 'pullMerge', src: "'origin/main'" }, undefined, dirty);
    assert.equal(pull.message, "Pull 'origin/main' into 'main'?");
    assert.deepEqual(labels(pull.buttons), ['Stash & Pull']);
    const facts = { branch: "'main'", onto: "'origin/main'", ontoShort: 'e4f5a6b', replay: 1, merges: 0 };
    const r = rebaseConfirmation({ ...facts, op: 'pullRebase', onUpstream: 0, upstream: undefined }, '', [
      { id: 'stash', label: 'Stash & Pull' },
    ]);
    assert.equal(r.message, "Pull 'origin/main' into 'main'?");
  });

  it('offers fast-forward or a merge commit with uncommitted changes too, each with what to do about them', () => {
    const d = mergeConfirmation(merge, false, {
      section: 'Uncommitted changes: 1 file.',
      modes: [
        { mode: 'noFastForward', choices: ['stash'] },
        { mode: 'ff', choices: ['keep', 'stash'] },
      ],
    });
    assert.equal(
      d.detail,
      "'main' can fast-forward to abc1234 (2 commits), or record a merge commit. Uncommitted changes: 1 file.",
    );
    assert.deepEqual(labels(d.buttons), [
      'Stash & Create Merge Commit',
      'Fast-Forward Keeping Changes',
      'Stash & Fast-Forward',
    ]);
    assert.deepEqual(
      d.buttons.map((b) => mergeAnswer(b.id)),
      [
        { mode: 'noFastForward', choice: 'stash' },
        { mode: 'ff', choice: 'keep' },
        { mode: 'ff', choice: 'stash' },
      ],
    );
  });

  it('says what a rebase replays and drops', () => {
    const r = rebaseConfirmation(
      {
        op: 'rebase',
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

  const parents = [
    { short: 'aaa1111', subject: 'Release prep', mergedIn: 3 },
    { short: 'bbb2222', subject: 'Add parser', mergedIn: 5 },
  ];

  it('names what a revert of a merge undoes, and that merging those commits again brings nothing', () => {
    const p = pickConfirmation('revert', c, "'main'", false, '', [], { parents, mainline: 1 });
    assert.equal(p.message, 'Revert abc1234 "Add lexer" on \'main\'?');
    assert.equal(
      p.detail,
      'Undoes the changes of the 3 commits it merged into aaa1111 "Release prep" from bbb2222 "Add parser". Merging those commits again later won\'t bring them back.',
    );
  });

  it('names what a cherry pick of a merge applies, relative to the parent chosen', () => {
    const p = pickConfirmation('cherryPick', c, 'HEAD', true, '', [], { parents, mainline: 2 });
    assert.equal(
      p.detail,
      'Applies the changes of the 5 commits it merged into bbb2222 "Add parser" from aaa1111 "Release prep". HEAD is detached: the new commit will be on no branch.',
    );
    const octopus = [...parents, { short: 'ccc3333', subject: 'Add docs', mergedIn: 1 }];
    assert.match(
      pickConfirmation('cherryPick', c, 'HEAD', false, '', [], { parents: octopus, mainline: 3 }).detail,
      /^Applies the changes of the 1 commit it merged into ccc3333 "Add docs" from aaa1111 and bbb2222\.$/,
    );
  });

  it('asks which parent a cherry pick of a merge applies its changes relative to', () => {
    assert.deepEqual(mainlinePick(c, parents), {
      title: 'Cherry Pick abc1234 "Add lexer"',
      placeholder: 'A merge commit: apply its changes relative to which parent?',
      items: [
        {
          label: 'Parent 1: aaa1111',
          description: 'Release prep',
          detail: 'Applies the 3 commits merged in from bbb2222',
        },
        {
          label: 'Parent 2: bbb2222',
          description: 'Add parser',
          detail: 'Applies the 5 commits merged in from aaa1111',
        },
      ],
    });
  });

  it('says where a stopped operation is and where the changes are', () => {
    assert.equal(
      stoppedMessage('rebase', { current: 3, total: 4 }, 'Add lexer', ['a.ts', 'b.ts'], 2, undefined, 'CONFLICT'),
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
        'CONFLICT',
      ),
      'Cherry pick stopped with conflicts in 1 file (a.ts). Your uncommitted changes are in stash@{0} ("On main: Strata autostash: cherry pick abc1234").',
    );
    assert.equal(
      stoppedMessage('cherryPick', undefined, 'Add lexer', [], 0, undefined, 'The previous cherry-pick is now empty'),
      'Cherry pick stopped ("Add lexer"): The previous cherry-pick is now empty.',
    );
    assert.equal(stillConflicted(['a.ts'], 1).message, '1 file still has conflicts: a.ts.');
    const stage = unstagedResolutions(['a.ts', 'b.ts']);
    assert.equal(stage.message, '2 resolved files are not staged yet: a.ts and b.ts.');
    assert.deepEqual(labels(stage.buttons), ['Stage & Continue']);
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
    const dirty = { files: 1, staged: 0, overlap: false, fastForward: false };
    const choices = resolveStashChoices('resetHard', dirty, 'gitConfig');
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
    assert.equal(
      HISTORY_DONE.reset("'main'", 'abc1234', 'stash@{0} ("x")', true),
      'Reset \'main\' to abc1234. Your changes to the files the reset changes are in stash@{0} ("x")',
    );
    assert.equal(HISTORY_DONE.aborted('cherryPick'), 'Aborted the cherry pick');
    assert.equal(
      alreadyReverted('abc1234', "'main'"),
      "abc1234 is already reverted on 'main': there is nothing to undo.",
    );
  });

  it('says when restoring stashed changes only partly worked, or not at all', () => {
    assert.equal(
      popPartial("Merged 'topic' into 'main'", 'stash@{0} ("On main: x")'),
      "Merged 'topic' into 'main'; only part of your stashed changes came back. The rest stays in stash@{0} (\"On main: x\").",
    );
    assert.equal(
      popRefused("Switched to 'x'", 'your local changes would be overwritten.', 'stash@{1} ("y")'),
      'Switched to \'x\'; git could not restore your stashed changes: your local changes would be overwritten. They stay in stash@{1} ("y").',
    );
  });
});
