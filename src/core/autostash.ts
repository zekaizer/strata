import type { Leftover, OperationState } from './repo-state.ts';

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
  /** Some of them are files the operation changes too. */
  overlap: boolean;
  /** The merge fast-forwards (merge, pull with merge). */
  fastForward: boolean;
}

/** Decides which answers an operation offers for uncommitted changes, and in which order. */
export function resolveStashChoices(op: StashOp, dirty: DirtyFacts, setting: AutostashSetting): StashChoices {
  const none: StashChoices = { choices: [], mechanism: 'git' };
  if (dirty.files === 0) return none;
  switch (op) {
    case 'resetHard':
      // Strata never pops this stash: popping would undo the reset. Offered first even with "never".
      return {
        choices: ['stash', 'discard'],
        mechanism: 'safety',
      };
    case 'resetKeep':
      if (!dirty.overlap) return none;
      return {
        choices: ['stash'],
        mechanism: 'safety',
      };
    case 'switch':
      // Without overlap git carries the changes to the target itself, losing nothing.
      if (!dirty.overlap) return none;
      return {
        choices: setting === 'never' ? ['migrate', 'stash'] : ['stash', 'migrate'],
        mechanism: 'explicit',
      };
    case 'rebase':
    case 'pullRebase':
      return { choices: ['stash'], mechanism: 'git' };
    case 'cherryPick':
    case 'revert':
      // git refuses over any staged change, or over changes to the files the commit changes,
      // before touching anything; other changes stay in place, also through a conflict and its abort.
      if (dirty.staged > 0) return { choices: ['stash'], mechanism: 'explicit' };
      if (!dirty.overlap) return none;
      return {
        choices: ['stash'],
        mechanism: 'explicit',
      };
    case 'merge':
    case 'pullMerge':
      // git refuses a merge commit over staged changes, even to other files; a fast-forward carries them.
      if (dirty.staged > 0 && !dirty.fastForward)
        return {
          choices: ['stash'],
          mechanism: 'git',
        };
      if (!dirty.overlap) return none;
      return {
        choices: ['stash'],
        mechanism: 'git',
      };
  }
}

/** Operations Strata stashes around itself (git has no autostash for them). */
export type ExplicitStashOp = 'switch' | 'cherryPick' | 'revert';

/** What Strata's stash messages start with, new first: older versions wrote "Strata autostash: ". */
const PREFIXES = ['Strata: changes set aside for the ', 'Strata autostash: '];
const EXPLICIT: Record<ExplicitStashOp, string> = { switch: 'switch', cherryPick: 'cherry pick', revert: 'revert' };

/** The message of a stash Strata pushes before `op` and pops after it; `target` names what it was for. */
export const autostashMessage = (op: ExplicitStashOp, target: string): string =>
  `${PREFIXES[0]!}${EXPLICIT[op]} ${target}`;

/** Whether stash message `message` (without git's "On main: ") is one autostashMessage made. */
export const isStrataAutostash = (message: string): boolean => PREFIXES.some((p) => message.startsWith(p));

/** The operation a stash was Strata's autostash for, from its reflog subject ("On main: Strata: …"). */
export function strataAutostashOf(reflogSubject: string): ExplicitStashOp | undefined {
  const message = /^On [^:]+: (.*)$/s.exec(reflogSubject)?.[1];
  const prefix = message === undefined ? undefined : PREFIXES.find((p) => message.startsWith(p));
  if (message === undefined || prefix === undefined) return undefined;
  const rest = message.slice(prefix.length);
  return (Object.keys(EXPLICIT) as ExplicitStashOp[]).find((op) => rest.startsWith(`${EXPLICIT[op]} `));
}

/**
 * What Strata remembers about a stash commit in one worktree, until the stash leaves the list. A
 * stash with no mark is not Strata's to restore.
 */
export type StashMark =
  /**
   * Strata pushed it before an operation and owes it a restore. `head`: the CHERRY_PICK_HEAD or
   * REVERT_HEAD of the stopped operation holding it, which restores it when it ends through Strata.
   */
  | { kind: 'pushed'; hash: string; head?: string }
  /** Strata saw restoring it conflict: it is never offered for restoring again. */
  | { kind: 'restoreConflicted'; hash: string };

/** The mark of the stash Strata pushed for the stopped cherry pick or revert `operation`. */
export function heldBy(
  marks: readonly StashMark[],
  operation: Pick<OperationState, 'kind' | 'applying'>,
): StashMark | undefined {
  if (operation.kind !== 'cherryPick' && operation.kind !== 'revert') return undefined;
  return marks.find((m) => m.kind === 'pushed' && m.head !== undefined && m.head === operation.applying);
}

/**
 * The marks once `operation` is in progress and `listed` is the stash list: a stash that left the
 * list is forgotten, and one whose operation ended without Strata is no longer held.
 */
export function settleMarks(
  marks: readonly StashMark[],
  operation: OperationState | undefined,
  listed: ReadonlySet<string>,
): StashMark[] {
  const held = operation && heldBy(marks, operation);
  return marks
    .filter((m) => listed.has(m.hash))
    .map((m) => (m.kind === 'pushed' && m.head !== undefined && m !== held ? { kind: 'pushed', hash: m.hash } : m));
}

/** Unmerged files a leftover lists, at most. */
const FILES_SHOWN = 50;

/**
 * What an earlier operation left for the user to settle, in the banner's order: a restore Strata
 * saw conflict, a stash Strata pushed here and nobody restored, unmerged files nobody resolves.
 * While an operation is in progress, only the stash it holds (its banner says where the changes are).
 */
export function leftoverOf(i: {
  operation: OperationState | undefined;
  /** stash@{0} first; `message` is the reflog subject. */
  stashes: readonly { hash: string; index: number; message: string; branch: string | undefined }[];
  unmerged: readonly string[];
  /** The branch HEAD is on in this worktree; undefined when detached. */
  headBranch: string | undefined;
  /** This worktree's marks. */
  marks: readonly StashMark[];
}): Leftover | undefined {
  const ref = (s: { hash: string; message: string }) => ({ hash: s.hash, message: s.message });
  const pending = (s: { hash: string; index: number; message: string }): Leftover | undefined => {
    const op = strataAutostashOf(s.message);
    return op === undefined ? undefined : { kind: 'pendingStash', stash: ref(s), operation: EXPLICIT[op] };
  };
  const marked = (kind: StashMark['kind']) =>
    i.stashes.filter((s) => i.marks.some((m) => m.hash === s.hash && m.kind === kind));
  if (i.operation) {
    const held = heldBy(i.marks, i.operation);
    const s = held && i.stashes.find((e) => e.hash === held.hash);
    return s && pending(s);
  }
  const [conflicted] = marked('restoreConflicted');
  if (conflicted) return { kind: 'restoreConflicted', stash: ref(conflicted), files: i.unmerged.slice(0, FILES_SHOWN) };
  for (const s of marked('pushed')) {
    const l = pending(s);
    if (l) return l;
  }
  if (i.unmerged.length === 0) return undefined;
  // refs/stash is shared by every worktree: only an autostash made on this worktree's branch is ours to name.
  const git = i.stashes.find((s) => s.message === 'autostash' && s.branch !== undefined && s.branch === i.headBranch);
  return {
    kind: 'unmerged',
    files: i.unmerged.slice(0, FILES_SHOWN),
    count: i.unmerged.length,
    autostash: git ? ref(git) : undefined,
  };
}
