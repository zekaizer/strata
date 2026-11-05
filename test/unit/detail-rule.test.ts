import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveStashChoices, type DirtyFacts } from '../../src/core/autostash.ts';
import * as w from '../../src/core/wording.ts';

const c = { short: 'abc1234', subject: 'Add lexer' };
const dirty: DirtyFacts = { files: 3, staged: 1, overlap: true, fastForward: false };
const section = (op: Parameters<typeof w.dirtySection>[1]) =>
  w.dirtySection(dirty, op, 1, op === 'resetHard' ? ['gen/out.txt'] : []);
const reset = {
  branch: 'main',
  target: c,
  dropped: { newest: [c, c], count: 3 },
  gained: 1,
  onUpstream: 1,
  unreachable: 2,
  upstream: 'origin/main',
  dirtyFiles: 3,
};
const parents = [
  { short: 'aaa1111', subject: 'Main', mergedIn: 3 },
  { short: 'bbb2222', subject: 'Side', mergedIn: 4 },
];
const both = [
  { id: 'rebase', label: 'Stash & Rebase' },
  { id: 'merge', label: 'Stash & Merge' },
];
const merge = {
  op: 'merge',
  src: "'topic'",
  into: "'main'",
  short: 'abc1234',
  count: 2,
  canFastForward: true,
} as const;

/** Every confirmation, with the facts that make its detail longest. */
const confirmations: [string, w.Confirmation | undefined][] = [
  [
    'merge, dirty',
    w.mergeConfirmation(merge, undefined, {
      section: section('merge'),
      modes: [
        { mode: 'ff', choices: resolveStashChoices('merge', dirty, 'gitConfig').choices },
        { mode: 'noFastForward', choices: ['stash'] },
      ],
    }),
  ],
  ['merge', w.mergeConfirmation(merge, false)],
  [
    'rebase, dirty',
    w.rebaseConfirmation(
      {
        op: 'rebase',
        branch: "'topic'",
        onto: "'main'",
        ontoShort: 'def5678',
        replay: 9,
        merges: 2,
        onUpstream: 9,
        upstream: 'origin/topic',
      },
      section('rebase'),
      w.stashButtons('rebase', ['stash']),
    ),
  ],
  ['reset, hard', w.resetConfirmation(reset, 'hard', true)],
  ['reset, keep', w.resetConfirmation(reset, 'keep', true)],
  [
    'cherry pick of a merge',
    w.pickConfirmation('cherryPick', c, 'HEAD', true, section('cherryPick'), w.stashButtons('cherryPick', ['stash']), {
      parents,
      mainline: 2,
    }),
  ],
  [
    'revert of a merge',
    w.pickConfirmation('revert', c, "'main'", false, section('revert'), w.stashButtons('revert', ['stash']), {
      parents,
      mainline: 1,
    }),
  ],
  ['abort', w.abortConfirmation('rebase', 'topic', 'abc1234', true, ['a.ts', 'b.ts'], 3)],
  ['skip', w.skipConfirmation(c, "'topic'", ['a.ts'])],
  [
    'switch',
    w.switchConfirmation("'feature'", ['a.ts'], section('switch'), w.stashButtons('switch', ['stash', 'migrate'])),
  ],
  ['leave behind', w.leaveBehindConfirmation(2, c)],
  ['tracks other', w.tracksOtherConfirmation('main', 'upstream/main', 'origin/main')],
  ['delete branch', w.deleteBranchConfirmation('feature', { newest: [c], count: 3 }, 'origin/feature')],
  ['undo moved', w.undoMovedConfirmation('feature', 'branch creation', 2, c, 'def5678')],
  ['undo moved, no commits', w.undoMovedConfirmation('main', 'merge', 0, c, 'def5678')],
  ['in the way', w.inTheWayConfirmation(w.IN_THE_WAY_OF.merge("'topic'"), ['a.js', 'b.js'])],
  ['message edits', w.messageEditsConfirmation(['reword abc1234', 'squash def5678'])],
  ['still conflicted', w.stillConflicted(['a.ts'], 1)],
  ['unstaged resolutions', w.unstagedResolutions(['a.ts', 'b.ts'])],
  ['operation in progress', w.operationInProgress('rebase', { current: 2, total: 5 })],
  ['conflicts in progress', w.conflictsInProgress(['a.ts'], 1)],
  ['shallow', w.shallowConfirmation("'main'", "'topic'")],
  ['shallow edge', w.shallowEdgeConfirmation('abc1234', 'a.ts')],
  ['drop stash', w.dropStashConfirmation(0, 'On main: wip', { changed: 3, untracked: 1 }, c)],
  [
    'diverged, dirty',
    w.divergedConfirmation("'main'", 'origin/main', 2, 3, both, w.PULL_NOTES.rebaseMerges, section('pullRebase')),
  ],
  ['push other name', w.pushOtherNameConfirmation('feature', 'origin', 'main')],
  ['push rejected', w.pushRejectedConfirmation('origin/main', 'main', 2, true, true)],
  ['force push', w.forcePushConfirmation('main', 'origin', 'origin/main', 2, 'Fix CI')],
  ['delete remote branch', w.deleteRemoteBranchConfirmation('origin', 'x', 'origin/x', c, [c], ['x', 'y'], true)],
  ['delete remote tag', w.deleteRemoteTagConfirmation('v1', 'origin', c)],
  ['sign in', w.signInConfirmation('origin', 'auth', 'Pull')],
  ['host key', w.signInConfirmation('origin', 'hostKey', 'Pull')],
];

/** Settings the user can't get an option without changing (the only config keys a detail may name). */
const NEEDED_SETTINGS = /pull\.ff/;
const CONFIG_KEY = /\b(?:merge|pull|branch|rebase|strata|git)\.[a-zA-Z]+\b/;
const JARGON = /\b(?:sequencer|ORIG_HEAD|autostash|credential helper|fsck)\b/i;

/** Questions whose every answer can lose work, or that rewrite pushed commits: they warn. */
const WARNS = new Set([
  'rebase, dirty',
  'reset, hard',
  'reset, keep',
  'revert of a merge',
  'abort',
  'skip',
  'leave behind',
  'delete branch',
  'undo moved',
  'undo moved, no commits',
  'drop stash',
  'force push',
  'delete remote branch',
  'delete remote tag',
]);

describe('confirmation levels', () => {
  for (const [name, q] of confirmations)
    it(`${name}: ${WARNS.has(name) ? 'warns' : 'informs'}`, () => {
      assert.equal(q?.level ?? 'warning', WARNS.has(name) ? 'warning' : 'info');
    });
});

describe('confirmation details', () => {
  for (const [name, q] of confirmations)
    it(`${name}: at most 3 short lines, no button labels, no config keys or jargon`, () => {
      assert.ok(q, 'asks');
      const lines = q.detail === '' ? [] : q.detail.split('\n');
      assert.ok(lines.length <= 3, `${lines.length} lines: ${q.detail}`);
      for (const line of lines) assert.ok(line.length <= 140, `long line (${line.length}): ${line}`);
      for (const b of q.buttons) {
        const label = b.label.replace(/\.\.\.$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        assert.doesNotMatch(q.detail, new RegExp(`\\b${label}\\b`), `restates "${b.label}"`);
      }
      const keys = q.detail.replace(NEEDED_SETTINGS, '');
      assert.doesNotMatch(keys, CONFIG_KEY);
      assert.doesNotMatch(`${q.message}\n${q.detail}`, JARGON);
    });
});
