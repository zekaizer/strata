import type { Leftover } from './repo-state.ts';

/** Operations that uncommitted changes can get in the way of. */
export type StashOp =
  'rebase' | 'merge' | 'pullRebase' | 'pullMerge' | 'cherryPick' | 'revert' | 'switch' | 'resetHard' | 'resetKeep';

/** strata.autoStash: which answer comes first when an operation finds uncommitted changes. */
export type AutostashSetting = 'gitConfig' | 'always' | 'never';

/**
 * What to do with uncommitted changes: stash them around the operation, keep them in place (git
 * carries them or refuses), let git merge them into the target (switch --merge), or discard them.
 */
export type StashChoice = 'stash' | 'keep' | 'migrate' | 'discard';

export interface StashChoices {
  /** Answers in order; the first is the default. Empty when nothing needs asking. */
  choices: StashChoice[];
  /** One sentence for the confirmation, naming where the default came from. */
  explain: string;
  /**
   * How 'stash' runs: git's own --autostash, Strata's stash push / operation / stash pop, or a
   * stash that is never popped (it keeps what a reset would otherwise discard).
   */
  mechanism: 'git' | 'explicit' | 'safety';
}

export interface DirtyFacts {
  /** Tracked files with uncommitted changes. */
  files: number;
  staged: number;
  /** Some of them differ between HEAD and the target too (switch, reset --keep). */
  overlap: boolean;
}

const NAMES: Record<StashOp, string> = {
  rebase: 'rebase',
  merge: 'merge',
  pullRebase: 'pull',
  pullMerge: 'pull',
  cherryPick: 'cherry-pick',
  revert: 'revert',
  switch: 'switch',
  resetHard: 'reset',
  resetKeep: 'reset',
};

/** Decides which answers an operation offers for uncommitted changes, and in which order. */
export function resolveStashChoices(
  op: StashOp,
  dirty: DirtyFacts,
  setting: AutostashSetting,
  /** merge.autoStash in git config; undefined when unset. */
  mergeAutoStash: boolean | undefined,
): StashChoices {
  const none: StashChoices = { choices: [], explain: '', mechanism: 'git' };
  if (dirty.files === 0) return none;
  const name = NAMES[op];
  switch (op) {
    case 'resetHard':
      // Strata never pops this stash: popping would undo the reset. Offered first even with "never".
      return {
        choices: ['stash', 'discard'],
        explain: 'A hard reset discards uncommitted changes; stashing first keeps them in the stash list.',
        mechanism: 'safety',
      };
    case 'resetKeep':
      if (!dirty.overlap) return none;
      return {
        choices: ['stash'],
        explain: "git can't keep changes to files the reset also changes.",
        mechanism: 'safety',
      };
    case 'switch':
      // Without overlap git carries the changes to the target itself, losing nothing.
      if (!dirty.overlap) return none;
      return {
        choices: setting === 'never' ? ['migrate', 'stash'] : ['stash', 'migrate'],
        explain:
          setting === 'never' ? 'strata.autoStash is "never".' : 'Stashing brings the changes back after switching.',
        mechanism: 'explicit',
      };
    case 'rebase':
    case 'pullRebase':
      return { choices: ['stash'], explain: `git can't ${name} with uncommitted changes.`, mechanism: 'git' };
    case 'cherryPick':
    case 'revert':
      if (dirty.staged > 0)
        return { choices: ['stash'], explain: `git can't ${name} with staged changes.`, mechanism: 'explicit' };
      return {
        choices: setting === 'always' ? ['stash', 'keep'] : ['keep', 'stash'],
        explain:
          setting === 'always'
            ? 'strata.autoStash is "always".'
            : `git ${name} has no autostash; changes stay in place.`,
        mechanism: 'explicit',
      };
    case 'merge':
    case 'pullMerge': {
      // Unset, git merges over changes it would only warn about losing: stashing comes first.
      const first =
        setting === 'gitConfig'
          ? mergeAutoStash === false
            ? 'keep'
            : 'stash'
          : setting === 'always'
            ? 'stash'
            : 'keep';
      const explain =
        setting !== 'gitConfig'
          ? `strata.autoStash is "${setting}".`
          : mergeAutoStash === undefined
            ? 'merge.autoStash is not set.'
            : `merge.autoStash is ${mergeAutoStash ? 'on' : 'off'}.`;
      return {
        choices: first === 'stash' ? ['stash', 'keep'] : ['keep', 'stash'],
        explain,
        mechanism: 'git',
      };
    }
  }
}

/** Operations Strata stashes around itself (git has no autostash for them). */
export type ExplicitStashOp = 'switch' | 'cherryPick' | 'revert';

const AUTOSTASH = 'Strata autostash: ';
const EXPLICIT: Record<ExplicitStashOp, string> = { switch: 'switch', cherryPick: 'cherry pick', revert: 'revert' };

/** The message of a stash Strata pushes before `op` and pops after it; `target` names what it was for. */
export const autostashMessage = (op: ExplicitStashOp, target: string): string =>
  `${AUTOSTASH}${EXPLICIT[op]} ${target}`;

/** The operation a stash was Strata's autostash for, from its reflog subject ("On main: Strata autostash: …"). */
export function strataAutostashOf(reflogSubject: string): ExplicitStashOp | undefined {
  const message = /^On [^:]+: (.*)$/s.exec(reflogSubject)?.[1];
  if (!message?.startsWith(AUTOSTASH)) return undefined;
  const rest = message.slice(AUTOSTASH.length);
  return (Object.keys(EXPLICIT) as ExplicitStashOp[]).find((op) => rest.startsWith(`${EXPLICIT[op]} `));
}

/** Unmerged files a leftover lists, at most. */
const FILES_SHOWN = 50;

/**
 * What an earlier operation left for the user to settle, in the banner's order: a restore Strata
 * saw conflict, a Strata stash nobody restored, unmerged files nobody resolves. Nothing while an
 * operation is in progress (it says where the changes are itself).
 */
export function leftoverOf(i: {
  operation: boolean;
  /** stash@{0} first; `message` is the reflog subject. */
  stashes: readonly { hash: string; index: number; message: string }[];
  unmerged: readonly string[];
  restoreConflicted: ReadonlySet<string>;
  kept: ReadonlySet<string>;
}): Leftover | undefined {
  if (i.operation) return undefined;
  const ref = (s: { hash: string; index: number }) => ({ hash: s.hash, index: s.index });
  const open = i.stashes.filter((s) => !i.kept.has(s.hash));
  const conflicted = open.find((s) => i.restoreConflicted.has(s.hash));
  if (conflicted) return { kind: 'restoreConflicted', stash: ref(conflicted), files: i.unmerged.slice(0, FILES_SHOWN) };
  for (const s of open) {
    const op = strataAutostashOf(s.message);
    if (op !== undefined) return { kind: 'pendingStash', stash: ref(s), operation: EXPLICIT[op] };
  }
  if (i.unmerged.length === 0) return undefined;
  const git = i.stashes.find((s) => s.message === 'autostash');
  return {
    kind: 'unmerged',
    files: i.unmerged.slice(0, FILES_SHOWN),
    count: i.unmerged.length,
    autostash: git ? ref(git) : undefined,
  };
}
