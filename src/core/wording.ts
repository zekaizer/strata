import type { DirtyFacts, StashChoice, StashOp } from './autostash.ts';
import { MORE_HISTORY, type MergeMode, type ResetMode } from './operations.ts';
import type { RefKind } from './refs.ts';
import type { WorktreeInfo } from './worktrees.ts';
import type { OperationKind } from './repo-state.ts';
import type { EditKind, Refusal, StayReason } from './rewrite.ts';

/** A commit as confirmations name it. */
export interface CommitRef {
  short: string;
  subject: string;
}

/** Commits, newest first: the first of them by name, and how many there are in all. */
export interface CommitList {
  newest: CommitRef[];
  count: number;
}

/** A modal question: the first button is the default; Cancel is always offered by VS Code. */
export interface Confirmation<B extends string = string> {
  message: string;
  detail: string;
  buttons: { id: B; label: string }[];
  /** A modal that informs rather than warns. */
  level?: 'info';
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "f.txt, g.txt and 3 more" */
export function fileList(paths: readonly string[], shown = 5): string {
  const head = paths.slice(0, paths.length > shown ? shown : paths.length);
  const rest = paths.length - head.length;
  if (rest > 0) return `${head.join(', ')} and ${rest} more`;
  return head.length <= 1 ? (head[0] ?? '') : `${head.slice(0, -1).join(', ')} and ${head[head.length - 1]!}`;
}

const quoted = (commits: CommitList, shown = 2): string => {
  const names = commits.newest.slice(0, shown).map((c) => `"${c.subject}"`);
  const rest = commits.count - names.length;
  return rest > 0 ? `${names.join(', ')} and ${rest} more` : fileList(names);
};

const OP_NAME: Record<OperationKind, string> = {
  rebase: 'rebase',
  merge: 'merge',
  cherryPick: 'cherry pick',
  revert: 'revert',
};
export const opName = (kind: OperationKind): string => OP_NAME[kind];
const OP_TITLE: Record<OperationKind, string> = {
  rebase: 'Rebase',
  merge: 'Merge',
  cherryPick: 'Cherry Pick',
  revert: 'Revert',
};

/**
 * The line of a confirmation about the uncommitted changes `op` would meet. `overwritten`: for a
 * hard reset, the untracked files at paths it restores.
 */
export function dirtySection(
  dirty: DirtyFacts,
  op: StashOp,
  submodules: number,
  overwritten: readonly string[] = [],
): string {
  const staged = dirty.staged > 0 ? ` (${dirty.staged} staged)` : '';
  const what = [
    ...(dirty.files > 0 ? [`uncommitted changes in ${plural(dirty.files, 'file')}${staged}`] : []),
    ...(overwritten.length > 0 ? [`untracked ${fileList(overwritten)}`] : []),
  ].join(' and ');
  const stay = submodules > 0 ? 'untracked files and changes inside submodules stay' : 'untracked files stay';
  return op === 'resetHard'
    ? `Undo can't bring back your ${what} once discarded${submodules > 0 ? '; changes inside submodules stay' : ''}.`
    : `${what.charAt(0).toUpperCase()}${what.slice(1)}; ${stay} in place.`;
}

export interface ResetFacts {
  /** Branch being reset; undefined when HEAD is detached. */
  branch: string | undefined;
  target: CommitRef;
  /** Commits that leave the branch, newest first. */
  dropped: CommitList;
  /** Commits the branch gains (reset to a commit on another line). */
  gained: number;
  /** Of the dropped commits: how many are on the upstream, and how many on no other ref. */
  onUpstream: number;
  unreachable: number;
  upstream: string | undefined;
  dirtyFiles: number;
}

/** What a reset in each mode does with the changes of the commits that leave the branch. */
const MODE_LINE: Record<ResetMode, string> = {
  soft: 'their changes stay staged',
  mixed: 'their changes stay in your files, unstaged',
  keep: 'their changes are dropped',
  hard: 'their changes are discarded',
};

/**
 * Asks only when commits leave the branch or work is discarded, or when `ask` (changes need an
 * answer). The flow adds the dirtySection as the last line.
 */
export function resetConfirmation(f: ResetFacts, mode: ResetMode, ask = false): Confirmation<'reset'> | undefined {
  if (!ask && f.dropped.count === 0 && !(mode === 'hard' && f.dirtyFiles > 0)) return undefined;
  const name = f.branch === undefined ? 'HEAD' : refName(f.branch);
  const n = f.dropped.count;
  const it = n === 1 ? 'it' : 'them';
  const moves =
    n === 0
      ? `${name} stays at ${f.target.short}.`
      : f.gained > 0
        ? `${name} moves to another line: drops ${plural(n, 'commit')} (${quoted(f.dropped)}), gains ${f.gained}; ${MODE_LINE[mode]}.`
        : `${name} moves back ${plural(n, 'commit')} (${quoted(f.dropped)}); ${MODE_LINE[mode]}.`;
  const also = [
    ...(f.unreachable > 0 && f.unreachable < n ? [`${f.unreachable} on no other branch`] : []),
    ...(f.onUpstream > 0 && f.upstream ? [`${f.onUpstream} also on ${refName(f.upstream)}`] : []),
  ];
  return {
    message: `Reset ${name} to ${f.target.short}?`,
    detail: [
      moves,
      ...(n > 0 ? [`Undo brings ${it} back${also.length > 0 ? ` (${also.join('; ')})` : ''}.`] : []),
      ...(mode === 'keep' ? ['Your uncommitted changes stay.'] : []),
    ].join('\n'),
    buttons: [{ id: 'reset', label: `Reset ${name}` }],
  };
}

/**
 * `unreachable`: the commits on no other branch, remote-tracking branch or tag, newest first.
 * Undefined when none: Undo restores the branch, so there is nothing to confirm.
 */
export function deleteBranchConfirmation(
  branch: string,
  unreachable: CommitList,
  upstream: string | undefined,
): Confirmation<'delete'> | undefined {
  const newest = unreachable.newest[0];
  if (!newest) return undefined;
  const n = unreachable.count;
  return {
    message: `Delete branch ${refName(branch)} and its ${plural(n, 'unmerged commit')}?`,
    detail: [
      `${plural(n, 'commit')} would be on no branch, newest ${commitName(newest)}.`,
      'Undo restores the branch.',
      ...(upstream ? [`${refName(upstream)} stays on its remote.`] : []),
    ].join('\n'),
    buttons: [{ id: 'delete', label: 'Delete Branch and Commits' }],
  };
}

/** The line and buttons for uncommitted changes an Abort or Skip (`verb`) would discard (`paths`). */
function discardedChanges(
  verb: 'Abort' | 'Skip',
  paths: readonly string[],
): { line: string; buttons: { id: 'stash' | 'discard'; label: string }[] } {
  return {
    line: `Your uncommitted changes in ${plural(paths.length, 'file')} (${fileList(paths)}) would be lost.`,
    buttons: [
      { id: 'stash', label: `Stash Changes & ${verb}` },
      { id: 'discard', label: `Discard Changes & ${verb}` },
    ],
  };
}

/**
 * `back`: where the abort resets to; `dropped`: commits the operation made since it started, which
 * the abort drops (a rebase's replayed so far); `discards`: paths with uncommitted changes the
 * abort would throw away (readDiscardedByAbort).
 */
export function abortConfirmation(
  op: OperationKind,
  branch: string | undefined,
  back: string,
  autostash: boolean,
  discards: readonly string[] = [],
  dropped = 0,
): Confirmation<'abort' | 'stash' | 'discard'> {
  const name = branch === undefined ? 'HEAD' : refName(branch);
  const discarded = discards.length > 0 ? discardedChanges('Abort', discards) : undefined;
  const lost = dropped > 0 ? `the ${plural(dropped, 'commit')} it ${op === 'rebase' ? 'replayed' : 'made'} and ` : '';
  return {
    message: `Abort the ${OP_NAME[op]}?`,
    detail: [
      `${name} goes back to ${back}, dropping ${lost}your conflict resolutions.`,
      "Strata can't undo this.",
      [discarded?.line, autostash ? 'Your stashed changes come back.' : undefined].filter(Boolean).join(' '),
    ]
      .filter((l) => l !== '')
      .join('\n'),
    buttons: discarded ? discarded.buttons : [{ id: 'abort', label: `Abort ${OP_TITLE[op]}` }],
  };
}

const branchName = (branch: string | undefined) => (branch === undefined ? 'HEAD' : refName(branch));

/**
 * `label` names what is undone ("merge", "branch creation"); `newer`: the commits made on the
 * branch since, which Undo drops, `newest` the last of them; `back` is where Undo moves HEAD.
 */
export function undoMovedConfirmation(
  branch: string | undefined,
  label: string,
  newer: number,
  newest: CommitRef,
  back: string,
): Confirmation<'undo'> {
  const name = branchName(branch);
  if (newer === 0)
    return {
      message: `${name} has moved since the ${label} (now at ${newest.short}).`,
      detail: `Undo moves it back to ${back}.`,
      buttons: [{ id: 'undo', label: 'Undo Anyway' }],
    };
  return {
    message: `Undo the ${label} and lose ${plural(newer, 'commit')} on ${name}?`,
    detail: [`Made since the ${label}, newest ${commitName(newest)}.`, "Strata can't undo this."].join('\n'),
    buttons: [{ id: 'undo', label: `Undo and Drop ${plural(newer, 'Commit')}` }],
  };
}

/** HEAD is on another branch than the one the operation moved, so Undo would move the wrong one. */
export const undoGone = (label: string, head: string): string =>
  `HEAD is now on ${head}, not on the branch the ${label} moved, so Undo was dropped.`;

export const undone = (label: string): string => `Undid the ${label}`;

/** Undo clicked on the notification of an operation that is no longer the last one. */
export const UNDO_STALE = 'Undo is no longer available: a newer operation ran.';

/** A line git, a server or a hook marks as why the command failed; advice (hint:) is not one. */
const CAUSE = /^(?:remote: +)?(?:error|fatal):|^\s*! \[/i;

/**
 * A failed git command as an error notification shows it: the lines that say why, with the files
 * they list (tab-indented under them), or the first lines when none is marked. At most 3 lines.
 */
export function gitFailure(message: string): string {
  const lines = message.trim().split('\n');
  let listing = false;
  const cause = lines.filter((line) => (listing = CAUSE.test(line) || (listing && line.startsWith('\t'))));
  return (cause.length > 0 ? cause : lines).slice(0, 3).join('\n');
}

/** The verb of each progress label (DOING, HISTORY_DOING, …), as "Couldn't …" says it. */
const FAILED_VERB: Record<string, string> = {
  Applying: 'apply',
  Aborting: 'abort',
  Continuing: 'continue',
  Creating: 'create',
  'Cherry picking': 'cherry pick',
  Deleting: 'delete',
  Dropping: 'drop',
  Fetching: 'fetch',
  Merging: 'merge',
  Popping: 'pop',
  Publishing: 'publish',
  Pushing: 'push',
  Rebasing: 'rebase',
  Renaming: 'rename',
  Resetting: 'reset',
  Reverting: 'revert',
  Skipping: 'skip',
  Staging: 'stage',
  Stashing: 'stash',
  Switching: 'switch',
  Undoing: 'undo',
  Unsetting: 'unset',
};

/** git failed `message` while running the operation of progress label `label`. */
export function failedDuring(label: string, message: string): string {
  const m = /^(Cherry picking|\S+) (.*)$/s.exec(label);
  const verb = m && FAILED_VERB[m[1]!];
  return verb ? `Couldn't ${verb} ${m[2]!}: ${message}` : `${label} failed: ${message}`;
}

export const gitTooOld = (found: string): string =>
  `Strata needs git 2.34 or newer to change repositories (found ${found}).`;

/** What follows from gitTooOld(), where it stands in the graph. */
export const WRITES_DISABLED = 'Commands that change the repository are disabled.';

/**
 * A remote operation that git could not authenticate (auth) or whose host it does not know yet
 * (hostKey). `rerun`: the command to run again afterwards, when the terminal runs only part of it.
 */
export function signInConfirmation(
  remote: string | undefined,
  kind: 'auth' | 'hostKey',
  rerun?: string,
): Confirmation<'terminal' | 'output'> {
  const name = remote === undefined ? 'a remote' : refName(remote);
  const then = rerun === undefined ? '.' : `, then run ${rerun} again.`;
  return {
    level: 'info',
    message: kind === 'auth' ? `Strata couldn't sign in to ${name}.` : `Strata couldn't connect to ${name}.`,
    detail:
      kind === 'auth'
        ? `git needs you to sign in, which Strata can't show. Run the same command in a terminal to sign in there${then}`
        : `Connect to the host once from a terminal to accept its key${then}`,
    buttons: [
      { id: 'terminal', label: 'Type in Terminal' },
      { id: 'output', label: 'Show Output' },
    ],
  };
}

/** Progress label of Undo Last Operation. */
export const undoLabel = (label: string): string => `Undoing the ${label}`;

/** A branch, remote-tracking branch, tag or remote as sentences name it: 'main', 'origin/main'. */
export const refName = (name: string): string => `'${name}'`;

/** A commit as sentences name it: abc1234 "Add lexer". */
export const commitName = (c: CommitRef): string => `${c.short} "${c.subject}"`;

/** `name`, as sentences name it, moved between the confirmation and the operation. */
export const changedMeanwhile = (name: string): string => `${name} changed while you were deciding; nothing was done.`;

/** A branch or tag Strata was about to create appeared since the graph read its refs. */
export const refAppeared = (kind: 'branch' | 'tag', name: string): string =>
  `A ${kind} named ${refName(name)} now exists; nothing was done.`;

/** A menu opened on a ref that is gone. */
export const staleTarget = (name: string): string => `${refName(name)} no longer exists; the graph has been refreshed.`;

export const staleWorktree = (path: string): string =>
  `The worktree at ${path} is no longer there; the graph has been refreshed.`;

const VERB: Record<StashOp, string> = {
  rebase: 'Rebase',
  merge: 'Merge',
  pullRebase: 'Pull',
  pullMerge: 'Pull',
  cherryPick: 'Cherry Pick',
  revert: 'Revert',
  switch: 'Switch',
  resetHard: 'Reset',
  resetKeep: 'Reset',
};

/** The buttons of a confirmation that asks what to do with uncommitted changes, in the order of `choices`. */
export function stashButtons<C extends StashChoice>(
  op: StashOp,
  choices: readonly C[],
  verb = VERB[op],
): { id: C; label: string }[] {
  const reset = op === 'resetHard' || op === 'resetKeep';
  const label: Record<StashChoice, string> = {
    stash: reset ? 'Stash Changes & Reset' : `Stash & ${verb}`,
    keep: `${verb} Keeping Changes`,
    migrate: 'Migrate Changes',
    discard: `Discard Changes & ${verb}`,
  };
  return choices.map((id) => ({ id, label: label[id] }));
}

/** `to`: the target as named in a sentence (a quoted branch or a short id); `section`: the dirtySection. */
export function switchConfirmation<C extends StashChoice>(
  to: string,
  overlap: readonly string[],
  section: string,
  buttons: { id: C; label: string }[],
): Confirmation<C> {
  return {
    level: 'info',
    message: `Switching to ${to} would overwrite your changes to ${plural(overlap.length, 'file')}.`,
    detail: [`${to} changes ${fileList(overlap)} too.`, section].filter((s) => s !== '').join('\n'),
    buttons,
  };
}

/** Operations as "untracked files in the way of the …" names them. */
export const IN_THE_WAY_OF = {
  /** `to`: as DOING.switching names it. */
  switch: (to: string): string => `switch to ${to}`,
  merge: (src: string): string => `merge of ${src}`,
  rebase: (onto: string): string => `rebase onto ${onto}`,
  cherryPick: (short: string): string => `cherry pick of ${short}`,
  revert: (short: string): string => `revert of ${short}`,
  stashBranch: (name: string): string => `switch to the new branch ${refName(name)}`,
};

/** The stash that moves untracked files out of the way of `op` (IN_THE_WAY_OF); Strata never pops it. */
export const inTheWayStash = (op: string): string => `Strata: untracked files in the way of ${op}`;

/** git refused `op` (IN_THE_WAY_OF) because untracked `files` are where it puts files of its own. */
export function inTheWayConfirmation(op: string, files: readonly string[]): Confirmation<'stash'> {
  const one = files.length === 1;
  return {
    level: 'info',
    message: `${plural(files.length, 'untracked file')} ${one ? 'is' : 'are'} in the way of the ${op}: ${fileList(files)}.`,
    detail: `The stash keeps ${one ? 'it' : 'them'}; Strata doesn't bring ${one ? 'it' : 'them'} back, because the ${op} puts its own ${one ? 'version' : 'versions'} there.`,
    buttons: [{ id: 'stash', label: one ? 'Stash It & Retry' : 'Stash Them & Retry' }],
  };
}

/** HEAD is detached on `head`, with `count` commits no ref reaches. */
export function leaveBehindConfirmation(count: number, head: CommitRef): Confirmation<'switch'> {
  return {
    message: `Leave ${plural(count, 'commit')} behind?`,
    detail: [
      `No branch has ${count === 1 ? 'it' : 'them'}; newest ${commitName(head)}.`,
      "Undo can't bring them back; only the reflog keeps them.",
    ].join('\n'),
    buttons: [{ id: 'switch', label: 'Switch Anyway' }],
  };
}

export const createBranchInput = (at: CommitRef): { title: string; prompt: string } => ({
  title: `Create Branch at ${commitName(at)}`,
  prompt: 'Creates the branch and switches to it.',
});

/** Checkout of remote branch `remote` whose local namesake `branch` tracks `upstream` instead. */
export function tracksOtherConfirmation(
  branch: string,
  upstream: string,
  remote: string,
): Confirmation<'switch' | 'new'> {
  return {
    level: 'info',
    message: `${refName(branch)} tracks ${refName(upstream)}, not ${refName(remote)}.`,
    detail: '',
    buttons: [
      { id: 'new', label: 'Create Tracking Branch...' },
      { id: 'switch', label: `Switch to ${refName(branch)}` },
    ],
  };
}

/** A new branch tracking remote branch `remote` (e.g. origin/main). */
export const trackingBranchInput = (remote: string): { title: string; prompt: string } => ({
  title: `Create Branch Tracking ${refName(remote)}`,
  prompt: 'Creates the branch and switches to it.',
});

export const createTagInput = (at: CommitRef): { title: string; prompt: string } => ({
  title: `Create Tag at ${commitName(at)}`,
  prompt: 'Enter the tag name.',
});

export const tagMessageInput = (tag: string, at: CommitRef): { title: string; prompt: string } => ({
  title: `Create Tag ${refName(tag)} at ${at.short}`,
  prompt: 'Message (empty for a lightweight tag)',
});

export const refExists = (kind: 'branch' | 'tag', name: string, short: string): string =>
  `A ${kind} named ${refName(name)} already exists (at ${short}).`;

/** `name` would be a directory of `other` or the other way around (pathConflict). */
export const refPathConflict = (kind: 'branch' | 'tag', name: string, other: string): string =>
  `A ${kind} can't be named ${refName(name)} while the ${kind} ${refName(other)} exists.`;

/** A rename to the name it has. */
export const NEEDS_NEW_NAME = 'Enter a different name.';

/** `remote`: the remote of the branch's upstream, whose branch keeps its name. */
export const renameInput = (branch: string, remote: string | undefined): { title: string; prompt: string } => ({
  title: `Rename Branch ${refName(branch)}`,
  prompt: [
    'Enter the new name.',
    ...(remote === undefined ? [] : [`${refName(branch)} on ${refName(remote)} keeps its name.`]),
  ].join(' '),
});

/** `where`: the worktree, or only its path when git named one the worktree list no longer has. */
export function checkedOutElsewhere(branch: string, where: WorktreeInfo | string | undefined): string {
  if (where === undefined || typeof where === 'string')
    return `${refName(branch)} is checked out in another worktree${where === undefined ? '' : ` (${where})`}.`;
  const state =
    where.state.kind === 'locked'
      ? ` It is locked${where.state.reason === undefined ? '' : `: ${where.state.reason}`}.`
      : where.state.kind === 'prunable'
        ? ' Its folder is gone; pruning the worktree frees the branch.'
        : '';
  return `${refName(branch)} is checked out in worktree ${refName(where.name)} (${where.path}).${state}`;
}

/** The buttons of checkedOutElsewhere: the worktree open in this window, in another, or pruned before `verb` again. */
export const ELSEWHERE = {
  show: 'Show in Graph',
  open: 'Open Worktree in New Window',
  prune: (verb: 'Checkout' | 'Delete' | 'Rename' | 'Pull'): string => `Prune and ${verb}`,
};

/** `done`: what the operation did; `paths`: the conflicted files; `stash`: stashLabel(), which git kept. */
export const popConflicted = (done: string, paths: readonly string[], stash: string): string =>
  `${done}; restoring your stashed changes conflicted in ${fileList(paths)}. They stay in ${stash}.`;

/** Apply or Pop of stash `label` (stashLabel) that conflicted in `paths`; git keeps a popped stash then. */
export const stashConflicted = (label: string, paths: readonly string[], pop: boolean): string =>
  `Applied ${label} with conflicts in ${fileList(paths)}${pop ? '; the stash was kept' : ''}.`;

/** Apply or Pop of stash `label` that git could restore only in part. */
export const stashPartial = (label: string, pop: boolean): string =>
  `Applied part of ${label}: git could not restore some files${pop ? '; the stash was kept' : ''}.`;

/**
 * A stash as messages name it, by its message without git's "On main:" or "WIP on main: 1a2b3c4"
 * prefix (`message`: the reflog subject): its number goes stale with the next push.
 */
export function stashLabel(message: string): string {
  const wip = /^WIP on [^:]+: (?:[0-9a-f]{7,} )?(.*)$/s.exec(message);
  const text = wip ? wip[1]! : message.replace(/^On [^:]+: /s, '');
  return text === 'autostash' ? 'the stash git made' : `stash "${text}"`;
}

export const migrateConflicted = (done: string, paths: readonly string[]): string =>
  `${done}; your changes conflicted in ${fileList(paths)}.`;

/** What a finished operation did, for the status bar and the Undo notification. */
export const DONE = {
  switched: (branch: string, behind?: { count: number; upstream: string }): string =>
    `Switched to ${refName(branch)}${behind ? ` (${behind.count} behind ${refName(behind.upstream)})` : ''}`,
  tracking: (branch: string, upstream: string): string => `Created ${refName(branch)} tracking ${refName(upstream)}`,
  detached: (short: string): string => `Detached HEAD at ${short}`,
  branchCreated: (name: string, short: string): string => `Created ${refName(name)} at ${short}`,
  tagCreated: (tag: string, short: string): string => `Created tag ${refName(tag)} at ${short}`,
  renamed: (from: string, to: string): string => `Renamed ${refName(from)} to ${refName(to)}`,
  branchDeleted: (branch: string): string => `Deleted branch ${refName(branch)}`,
  tagDeleted: (tag: string): string => `Deleted tag ${refName(tag)}`,
  copied: (name: string): string => `Copied ${refName(name)}`,
  copiedHash: (short: string): string => `Copied the commit hash of ${short}`,
  copiedShortHash: (short: string): string => `Copied ${short}`,
  copiedSubject: (short: string): string => `Copied the subject of ${short}`,
  worktreeRemoved: (name: string): string => `Removed worktree ${refName(name)}`,
  worktreesPruned: (names: readonly string[]): string =>
    names.length === 1
      ? `Pruned worktree ${refName(names[0]!)}, whose folder is gone`
      : `Pruned ${plural(names.length, 'worktree')} whose folders are gone`,
  copiedHashes: (n: number): string => `Copied ${n} commit ${n === 1 ? 'hash' : 'hashes'}`,
};

/** Progress labels: what is running. `to` is named as in a sentence (a quoted branch or a short id). */
export const DOING = {
  switching: (to: string): string => `Switching to ${to}`,
  creatingBranch: (name: string): string => `Creating branch ${refName(name)}`,
  creatingTag: (tag: string): string => `Creating tag ${refName(tag)}`,
  renaming: (branch: string): string => `Renaming ${refName(branch)}`,
  deletingBranch: (branch: string): string => `Deleting branch ${refName(branch)}`,
  deletingTag: (tag: string): string => `Deleting tag ${refName(tag)}`,
  removingWorktree: (name: string): string => `Removing worktree ${refName(name)}`,
  pruningWorktrees: 'Pruning worktrees',
};

/**
 * Remove Worktree: `changes` uncommitted (untracked files included), which `git worktree remove`
 * refuses without --force; `branch`: short name, undefined when detached; `locked`: its reason ('' none).
 */
export function removeWorktreeConfirmation(w: {
  name: string;
  path: string;
  branch: string | undefined;
  changes: number;
  locked: string | undefined;
}): Confirmation<'remove'> {
  return {
    message: `Remove worktree ${refName(w.name)}?`,
    detail: [
      `Its folder ${w.path} is deleted.`,
      ...(w.changes > 0 ? [`Its ${plural(w.changes, 'uncommitted change')}, untracked files included, are lost.`] : []),
      ...(w.locked === undefined ? [] : [`It is locked${w.locked === '' ? '' : `: ${w.locked}`}.`]),
      w.branch === undefined
        ? 'Commits only its detached HEAD reaches leave the graph.'
        : `Branch ${refName(w.branch)} stays.`,
    ].join('\n'),
    buttons: [{ id: 'remove', label: w.changes > 0 || w.locked !== undefined ? 'Remove Anyway' : 'Remove Worktree' }],
  };
}

/** Type in Terminal could not quote the command for the terminal's shell; `line` is quoted for a POSIX shell. */
export const commandUnquotable = (line: string): string =>
  `Strata can't quote this command safely for your terminal's shell. Run it there yourself, quoted for that shell: ${line}`;

const OP_SENTENCE: Record<OperationKind, string> = {
  rebase: 'Rebase',
  merge: 'Merge',
  cherryPick: 'Cherry pick',
  revert: 'Revert',
};

export interface MergeFacts {
  /** A merge from the menu, or the merge of a pull, which titles and buttons call Pull. */
  op: 'merge' | 'pullMerge';
  /** The source and the branch merged into, as sentences name them (quoted, or a short id / HEAD). */
  src: string;
  into: string;
  /** The source commit, and how many commits the merge brings. */
  short: string;
  count: number;
  canFastForward: boolean;
}

/** A dirty merge's answer: how it records the result, and what it does with the changes. */
export type MergeStashAnswer = `${MergeMode}+${StashChoice}`;

const MODE_VERB: Record<MergeMode, string> = { ff: 'Fast-Forward', noFastForward: 'Create Merge Commit' };

export function mergeAnswer(id: MergeStashAnswer): { mode: MergeMode; choice: StashChoice } {
  const [mode, choice] = id.split('+') as [MergeMode, StashChoice];
  return { mode, choice };
}

/**
 * Clean (a merge that can fast-forward): Fast-Forward or Create Merge Commit, merge commit first
 * when merge.ff is false. Dirty: for each of `modes`, in order, a button per answer about the changes.
 */
export function mergeConfirmation(f: MergeFacts, mergeFf: boolean | undefined): Confirmation<MergeMode>;
export function mergeConfirmation(
  f: MergeFacts,
  mergeFf: boolean | undefined,
  dirty: { section: string; modes: { mode: MergeMode; choices: readonly StashChoice[] }[] },
): Confirmation<MergeStashAnswer>;
export function mergeConfirmation(
  f: MergeFacts,
  mergeFf: boolean | undefined,
  dirty?: { section: string; modes: { mode: MergeMode; choices: readonly StashChoice[] }[] },
): Confirmation<MergeMode | MergeStashAnswer> {
  const commits = plural(f.count, 'commit');
  const fastForwards = `${f.into} fast-forwards to ${f.short} (${commits}).`;
  const records = `Creates a merge commit on ${f.into} with ${commits} from ${f.src}.`;
  const either = `Brings ${commits} from ${f.src} (${f.short}) into ${f.into}.`;
  const message = `${VERB[f.op]} ${f.src} into ${f.into}?`;
  if (dirty) {
    const [only] = dirty.modes;
    const both = dirty.modes.length > 1;
    return {
      level: 'info',
      message,
      detail: [both ? either : f.canFastForward && only?.mode === 'ff' ? fastForwards : records, dirty.section].join(
        '\n',
      ),
      buttons: dirty.modes.flatMap(({ mode, choices }) =>
        stashButtons(f.op, choices, both ? MODE_VERB[mode] : undefined).map((b) => ({
          id: `${mode}+${b.id}` as const,
          label: b.label,
        })),
      ),
    };
  }
  const both: { id: MergeMode; label: string }[] = [
    { id: 'ff', label: 'Fast-Forward' },
    { id: 'noFastForward', label: 'Create Merge Commit' },
  ];
  return { level: 'info', message, detail: either, buttons: mergeFf === false ? both.reverse() : both };
}

export interface RebaseFacts {
  /** A rebase from the menu, or the rebase of a pull, which the title calls Pull. */
  op: 'rebase' | 'pullRebase';
  branch: string;
  onto: string;
  ontoShort: string;
  /** Commits git replays (merges dropped, patches already upstream skipped). */
  replay: number;
  merges: number;
  /** Of the replayed commits, how many are on the upstream. */
  onUpstream: number;
  upstream: string | undefined;
  /** FORCE_PUSH_SETTING is on. */
  canForce: boolean;
}

export function rebaseConfirmation<B extends string>(
  f: RebaseFacts,
  section: string,
  buttons: { id: B; label: string }[],
): Confirmation<B> {
  const drops = f.merges > 0 ? `, without its ${plural(f.merges, 'merge commit')}` : '';
  const pushed =
    f.onUpstream > 0 && f.upstream
      ? ` ${f.onUpstream === 1 ? '1 is' : `${f.onUpstream} are`} on ${refName(f.upstream)}: you'll need to force push.`
      : '';
  return {
    ...(drops === '' && pushed === '' ? { level: 'info' as const } : {}),
    message: f.op === 'pullRebase' ? `Pull ${f.onto} into ${f.branch}?` : `Rebase ${f.branch} onto ${f.onto}?`,
    detail: [
      `Replays ${plural(f.replay, 'commit')} of ${f.branch} on ${f.onto} (${f.ontoShort})${drops}.${pushed}`,
      `${pushed !== '' && !f.canForce ? `${FORCE_PUSH_NEEDS_SETTING} ` : ''}Undo restores the original commits.`,
      section,
    ]
      .filter((s) => s !== '')
      .join('\n'),
    buttons,
  };
}

/** A merge commit's parents in order; `mergedIn`: how many commits the other parents bring that it lacks. */
export interface MergeParents {
  parents: readonly (CommitRef & { mergedIn: number })[];
  /** The parent (1-based) the changes are taken relative to. */
  mainline: number;
}

/** The parents to cherry pick merge `c` relative to, the first preselected. */
export function mainlinePick(
  c: CommitRef,
  parents: MergeParents['parents'],
): { title: string; placeholder: string; items: { label: string; description: string; detail: string }[] } {
  return {
    title: `Cherry Pick ${commitName(c)}`,
    placeholder: 'A merge commit: apply its changes relative to which parent?',
    items: parents.map((p, i) => ({
      label: `Parent ${i + 1}: ${p.short}`,
      description: p.subject,
      detail: `Applies the ${plural(p.mergedIn, 'commit')} merged in from ${fileList(
        parents.filter((o) => o !== p).map((o) => o.short),
      )}`,
    })),
  };
}

/** What a cherry pick or revert of a merge applies or undoes. */
function mergeSentence(kind: 'cherryPick' | 'revert', m: MergeParents): string {
  const main = m.parents[m.mainline - 1]!;
  const others = m.parents.filter((p) => p !== main);
  const from = others.length === 1 ? commitName(others[0]!) : fileList(others.map((o) => o.short));
  const changes = `the changes of the ${plural(main.mergedIn, 'commit')} it merged into ${commitName(main)} from ${from}.`;
  return kind === 'cherryPick' ? `Applies ${changes}` : `Undoes ${changes} Merging them again won't bring them back.`;
}

/** What a cherry pick or revert of several commits does, in the order git takes them. */
function severalSentence(kind: 'cherryPick' | 'revert', commits: readonly CommitRef[]): string {
  const names = fileList(
    commits.map((c) => `"${c.subject}"`),
    2,
  );
  return kind === 'cherryPick'
    ? `Applies them oldest first: ${names}.`
    : `Undoes them newest first, in one new commit each: ${names}.`;
}

/**
 * Cherry pick or revert of `commits`, in the order git applies them, on `onto` (a quoted branch,
 * or HEAD); `merge`: of a single merge commit.
 */
export function pickConfirmation<B extends string>(
  kind: 'cherryPick' | 'revert',
  commits: readonly CommitRef[],
  onto: string,
  detached: boolean,
  section: string,
  buttons: { id: B; label: string }[],
  merge?: MergeParents,
): Confirmation<B> {
  const several = commits.length > 1;
  const what = several ? plural(commits.length, 'commit') : commitName(commits[0]!);
  return {
    ...(kind === 'revert' && merge !== undefined ? {} : { level: 'info' as const }),
    message: kind === 'cherryPick' ? `Cherry pick ${what} onto ${onto}?` : `Revert ${what} on ${onto}?`,
    detail: [
      several ? severalSentence(kind, commits) : merge === undefined ? '' : mergeSentence(kind, merge),
      detached ? `HEAD is detached: the new ${several ? 'commits' : 'commit'} will be on no branch.` : '',
      section,
    ]
      .filter((s) => s !== '')
      .join('\n'),
    buttons,
  };
}

export const alreadyContains = (into: string, what: string): string => `${into} already contains ${what}.`;
/** The commits of a cherry pick or revert as its labels and result name them: one by its id, several by their count. */
export const pickedName = (commits: readonly CommitRef[]): string =>
  commits.length === 1 ? commits[0]!.short : plural(commits.length, 'commit');
/** Every commit of a cherry pick is in `into` already. */
export const alreadyContainsPicked = (into: string, commits: readonly CommitRef[]): string =>
  alreadyContains(into, commits.length === 1 ? commits[0]!.short : `all ${plural(commits.length, 'commit')}`);
/** A cherry pick or revert of several commits is refused: `merge` is among them. */
export const mergeAmongPicked = (kind: 'cherryPick' | 'revert', merge: CommitRef): string =>
  `Can't ${OP_NAME[kind]} these commits together: ${commitName(merge)} is a merge commit, and what it changes depends on the parent it is compared with. ${kind === 'cherryPick' ? 'Cherry pick' : 'Revert'} it on its own.`;
/** A revert of `short` on `onto` found nothing to undo. */
export const alreadyReverted = (short: string, onto: string): string =>
  `${short} is already reverted on ${onto}: there is nothing to undo.`;
/** Why a revert of several commits stopped at one that changes nothing, as stoppedMessage's reason. */
export const NOTHING_TO_REVERT = 'one of the commits is already reverted, so there is nothing to undo for it';
export const alreadyBased = (branch: string, onto: string): string => `${branch} is already based on ${onto}.`;

/** The reset modes in the order offered: git's default first. */
export const RESET_MODES: readonly { mode: ResetMode; label: string; description: string }[] = [
  { mode: 'mixed', label: 'Mixed', description: 'Keep their changes in your files, unstaged' },
  { mode: 'soft', label: 'Soft', description: 'Keep their changes staged' },
  {
    mode: 'keep',
    label: 'Keep',
    description: 'Drop their changes; keep your uncommitted changes (stops if they touch the same files)',
  },
  { mode: 'hard', label: 'Hard', description: 'Discard their changes and your uncommitted changes' },
];

export const resetPick = (
  branch: string,
  target: CommitRef,
  leaving: number,
): { title: string; placeholder: string } => ({
  title: `Reset ${branch} to ${commitName(target)}`,
  placeholder:
    leaving > 0
      ? `${plural(leaving, 'commit')} leave ${branch}. What happens to their changes?`
      : 'How should the reset treat your files?',
});

/** `held`: where Strata stashed the uncommitted changes (stashLabel), when it did. */
/** `reason`: what git said, for a stop without conflicts. */
export function stoppedMessage(
  kind: OperationKind,
  step: { current: number; total: number } | undefined,
  subject: string | undefined,
  conflicts: readonly string[],
  count: number,
  held: string | undefined,
  reason: string,
): string {
  const where = `${OP_SENTENCE[kind]} stopped${step ? ` at ${step.current} of ${step.total}` : ''}${subject === undefined ? '' : ` ("${subject}")`}`;
  return [
    count > 0
      ? `${where} with conflicts in ${plural(count, 'file')} (${fileList(conflicts)}).`
      : `${where}: ${/[.!?]$/.test(reason) ? reason : `${reason}.`}`,
    ...(held === undefined ? [] : [`Your uncommitted changes are in ${held}.`]),
  ].join(' ');
}

/** Continue of a rebase whose `steps` (messageEdits) have git open the commit message editor. */
export function messageEditsConfirmation(steps: readonly string[]): Confirmation<'terminal' | 'continue'> {
  return {
    level: 'info',
    message: 'Continuing this rebase edits commit messages.',
    detail: [
      `git would open an editor for ${fileList(steps)}, which Strata can't show.`,
      'Continued here, they keep the messages git prepares.',
    ].join('\n'),
    buttons: [
      { id: 'terminal', label: 'Continue in Terminal' },
      { id: 'continue', label: 'Continue Anyway' },
    ],
  };
}

/** What Continue of a rebase stopped at `step` does next. */
export function rebaseContinues(step: { current: number; total: number } | undefined): string {
  const remaining = step ? step.total - step.current : 0;
  return remaining > 0 ? `replays the remaining ${plural(remaining, 'commit')}` : 'completes the rebase';
}

export const abortButton = (kind: OperationKind): string => `Abort ${OP_TITLE[kind]}...`;

/** Continue while files still have conflict markers, or conflicts git can't show as markers. */
export function stillConflicted(paths: readonly string[], count: number): Confirmation<'resolve'> {
  return {
    message: `${plural(count, 'file')} still ${count === 1 ? 'has' : 'have'} conflicts: ${fileList(paths)}.`,
    detail: 'Continue once they are resolved and staged.',
    buttons: [{ id: 'resolve', label: 'Resolve...' }],
    level: 'info',
  };
}

/** Continue with conflicted files that have no conflict markers left but are not staged yet. */
export function unstagedResolutions(paths: readonly string[]): Confirmation<'stage'> {
  const one = paths.length === 1;
  return {
    message: `${plural(paths.length, 'resolved file')} ${one ? 'is' : 'are'} not staged yet: ${fileList(paths)}.`,
    detail: `${one ? 'Its' : 'Their'} conflict markers are gone.`,
    buttons: [{ id: 'stage', label: 'Stage & Continue' }],
    level: 'info',
  };
}

/** `discards`: paths with uncommitted changes the skip would throw away (readDiscardedByAbort). */
export function skipConfirmation(
  c: CommitRef,
  branch: string,
  discards: readonly string[] = [],
): Confirmation<'skip' | 'stash' | 'discard'> {
  const discarded = discards.length > 0 ? discardedChanges('Skip', discards) : undefined;
  return {
    message: `Skip ${commitName(c)}?`,
    detail: [`Its changes won't be in ${branch}.`, ...(discarded ? [discarded.line] : [])].join('\n'),
    buttons: discarded ? discarded.buttons : [{ id: 'skip', label: 'Skip Commit' }],
  };
}

/** A write while an operation is stopped. */
export function operationInProgress(
  kind: OperationKind,
  step: { current: number; total: number } | undefined,
): Confirmation<'continue' | 'abort'> {
  return {
    message: `A ${OP_NAME[kind]} is in progress${step ? ` (stopped at ${step.current} of ${step.total})` : ''}.`,
    detail: 'Finish or abort it before starting another operation.',
    buttons: [
      { id: 'continue', label: 'Continue' },
      { id: 'abort', label: abortButton(kind) },
    ],
    level: 'info',
  };
}

/** A write while files are unmerged and no operation is in progress. */
export function conflictsInProgress(paths: readonly string[], count: number): Confirmation<'resolve'> {
  return {
    message: `${plural(count, 'file')} ${count === 1 ? 'has' : 'have'} unresolved conflicts: ${fileList(paths)}.`,
    detail: 'Another operation can start once they are resolved.',
    buttons: [{ id: 'resolve', label: 'Resolve...' }],
    level: 'info',
  };
}

/** Two lines to merge share no commit in this repository. */
export const UNRELATED = 'These histories have no commit in common here.';

/** What a shallow clone can fetch of its history: MORE_HISTORY commits further back, or all of it. */
export type HistoryFetch = 'deepen' | 'unshallow';

const FETCH_HISTORY = {
  detail: 'Fetch more of it, then try again.',
  buttons: [
    { id: 'deepen', label: 'Fetch More History' },
    { id: 'unshallow', label: 'Fetch Full History' },
  ],
} satisfies Pick<Confirmation<HistoryFetch>, 'detail' | 'buttons'>;

/** A shallow clone lacks the commits an operation needs. */
export function shallowConfirmation(a: string, b: string): Confirmation<HistoryFetch> {
  return {
    level: 'info',
    message: `This clone is shallow: ${a} and ${b} have no common commit in it.`,
    ...FETCH_HISTORY,
  };
}

/** `short` is a commit a shallow clone has without its parent; `path`: the one file of it asked about. */
export function shallowEdgeConfirmation(short: string, path?: string): Confirmation<HistoryFetch> {
  const changes = path === undefined ? 'its changes' : `its changes to ${path}`;
  return {
    level: 'info',
    message: `${short} is the oldest commit this shallow clone has; its parent is not here, so ${changes} cannot be told apart from the whole ${path === undefined ? 'tree' : 'file'}.`,
    ...FETCH_HISTORY,
  };
}

/** What a finished history operation did. */
export const HISTORY_DONE = {
  fastForwarded: (into: string, short: string): string => `Fast-forwarded ${into} to ${short}`,
  merged: (src: string, into: string): string => `Merged ${src} into ${into}`,
  rebased: (branch: string, onto: string, count: number): string =>
    `Rebased ${branch} onto ${onto} (${plural(count, 'commit')})`,
  /** `what`: as pickedName names it. `already`: commits left out because `onto` had them. */
  picked: (what: string, onto: string, already = 0): string =>
    `Cherry-picked ${what} onto ${onto}${already === 0 ? '' : ` (${already} more ${already === 1 ? 'was' : 'were'} already there)`}`,
  reverted: (what: string): string => `Reverted ${what}`,
  /** `kept`: the reset kept the changes that are not in `stash` in place (reset --keep). */
  reset: (branch: string, short: string, stash: string | undefined, kept = false): string =>
    `Reset ${branch} to ${short}${stash === undefined ? '' : `. Your ${kept ? 'changes to the files the reset changes' : 'uncommitted changes'} are in ${stash}`}`,
  continued: (kind: OperationKind): string => `Finished the ${OP_NAME[kind]}`,
  aborted: (kind: OperationKind, stash?: string): string =>
    `Aborted the ${OP_NAME[kind]}${stash === undefined ? '' : `. Your uncommitted changes are in ${stash}`}`,
  skipped: (short: string, stash?: string): string =>
    `Skipped ${short}${stash === undefined ? '' : `. Your uncommitted changes are in ${stash}`}`,
  fetchedHistory: {
    deepen: `Fetched ${MORE_HISTORY} more commits of history`,
    unshallow: 'Fetched the full history',
  } satisfies Record<HistoryFetch, string>,
};

export const HISTORY_DOING = {
  merging: (src: string, into: string): string => `Merging ${src} into ${into}`,
  rebasing: (branch: string, onto: string): string => `Rebasing ${branch} onto ${onto}`,
  picking: (short: string): string => `Cherry picking ${short}`,
  reverting: (short: string): string => `Reverting ${short}`,
  resetting: (branch: string, short: string): string => `Resetting ${branch} to ${short}`,
  continuing: (kind: OperationKind): string => `Continuing the ${OP_NAME[kind]}`,
  aborting: (kind: OperationKind): string => `Aborting the ${OP_NAME[kind]}`,
  skipping: (short: string): string => `Skipping ${short}`,
  staging: (n: number): string => `Staging ${plural(n, 'resolved file')}`,
  fetchingHistory: {
    deepen: `Fetching ${MORE_HISTORY} more commits of history`,
    unshallow: 'Fetching the full history',
  } satisfies Record<HistoryFetch, string>,
};

/** Restoring stashed changes after `done` applied only part of them (git kept the stash). */
export const popPartial = (done: string, stash: string): string =>
  `${done}; only part of your stashed changes came back. The rest stays in ${stash}.`;

/** git refused to restore stashed changes after `done`; nothing was applied. */
export const popRefused = (done: string, reason: string, stash: string): string =>
  `${done}; git could not restore your stashed changes: ${reason} They stay in ${stash}.`;

/** Why git did not apply its autostash, for popRefused: local changes to `paths` (none known: unnamed). */
export const autostashRefused = (paths: readonly string[]): string =>
  `they would overwrite your changes${paths.length > 0 ? ` to ${fileList(paths)}` : ''}.`;

export const OPEN_SCM = 'Open Source Control View';

export const NOTHING_TO_STASH = 'No local changes to stash.';
/** After `git stash push` made no stash, with `submodules` changed inside. */
export const nothingStashed = (submodules: number): string =>
  submodules > 0 ? 'No local changes to stash: git never stashes changes inside submodules.' : NOTHING_TO_STASH;

/** `n` changed tracked files, `staged` of them staged; `untracked`: Include Untracked. */
export function stashPushInput(n: number, staged: number, untracked: boolean): { title: string; prompt: string } {
  const files = n > 0 ? `${plural(n, 'changed file')}${staged > 0 ? ` (${staged} staged)` : ''}` : '';
  const what = [files, untracked ? 'untracked files' : ''].filter((s) => s !== '').join(' and ');
  return { title: 'Stash Changes', prompt: `Message (optional). Stashes ${what}.` };
}

/** `files`: counted changes, undefined when not counted in time; `base`: the commit it was made on. */
export function dropStashConfirmation(
  index: number,
  message: string,
  files: { changed: number; untracked: number } | undefined,
  base: CommitRef,
): Confirmation<'drop'> {
  const on = commitName(base);
  const holds =
    files === undefined
      ? `Made on ${on}.`
      : `${plural(files.changed, 'changed file')}${files.untracked > 0 ? ` and ${files.untracked} untracked` : ''} on ${on}.`;
  return {
    message: `Drop ${stashLabel(message)}?`,
    detail: [holds, "Undo brings it back; after that Strata can't."].join('\n'),
    buttons: [{ id: 'drop', label: 'Drop Stash' }],
  };
}

/**
 * Applying stash `label` (stashLabel), or creating a branch from it (`again`), would leave `files`,
 * which its untracked part adds, as they are here.
 */
export function stashFilesExist(label: string, files: readonly string[], again = 'apply again'): string {
  const one = files.length === 1;
  return `${label} adds ${one ? 'a file that already exists' : 'files that already exist'} here: ${fileList(files)}. Move ${one ? 'it' : 'them'} away and ${again}.`;
}

/** Branch `name` was created from stash `label` (stashLabel), but git did not restore `files`, which exist here. */
export function stashBranchPartial(name: string, label: string, files: readonly string[]): string {
  const one = files.length === 1;
  return `Created ${refName(name)} from ${label}, but ${fileList(files)} did not come back because ${one ? 'it already exists' : 'they already exist'} here. The stash is kept.`;
}

export const stashBranchInput = (index: number, message: string, short: string): { title: string; prompt: string } => ({
  title: `Create Branch from ${stashLabel(message)}`,
  prompt: `Creates the branch at ${short}, switches to it, restores the stash there and removes it from the stash list.`,
});

export const stashBranchDirty = (short: string): string =>
  `Commit or stash your uncommitted changes first: the branch starts at ${short}.`;

/** What a finished stash operation did; `label` is stashLabel(). */
export const STASH_DONE = {
  stashed: (n: number, label: string): string => `Stashed ${plural(n, 'file')} as ${label}`,
  applied: (label: string): string => `Applied ${label}`,
  popped: (label: string): string => `Popped ${label}`,
  dropped: (label: string): string => `Dropped ${label}`,
  branched: (name: string, label: string): string => `Created ${refName(name)} from ${label} and applied it`,
};

export const STASH_DOING = {
  stashing: 'Stashing changes',
  applying: (label: string): string => `Applying ${label}`,
  popping: (label: string): string => `Popping ${label}`,
  dropping: (label: string): string => `Dropping ${label}`,
  branching: (name: string): string => `Creating ${refName(name)} from a stash`,
};

export const NO_REMOTE = 'This repository has no remote.';

export const noUpstream = (branch: string): string => `${refName(branch)} has no upstream branch.`;

export const upstreamGone = (branch: string, upstream: string): string =>
  `${refName(upstream)}, the upstream of ${refName(branch)}, is gone from its remote. Publish the branch again, or unset its upstream.`;

/** A detached HEAD has no branch to pull into or push. */
export const detachedNoBranch = (action: 'pull' | 'push'): string =>
  `HEAD is detached: switch to a branch to ${action}.`;

/**
 * Pull of a branch that diverged from its upstream. `buttons`: Rebase and Merge as config permits
 * (and as uncommitted changes need, stashButtons); `note` says why one is missing or differs;
 * `section`: the dirtySection, when there are changes to ask about.
 */
export function divergedConfirmation<B extends string>(
  branch: string,
  upstream: string,
  ahead: number,
  behind: number,
  buttons: { id: B; label: string }[],
  note: string | undefined,
  section = '',
): Confirmation<B> {
  return {
    level: 'info',
    message: divergedFrom(branch, upstream, ahead, behind),
    detail: [note ?? '', section].filter((s) => s !== '').join('\n'),
    buttons,
  };
}

/** `branch` as sentences name it (quoted); `upstream` as git names it. */
const divergedFrom = (branch: string, upstream: string, ahead: number, behind: number): string =>
  `${branch} has ${plural(ahead, 'commit')} ${refName(upstream)} lacks and is ${behind} behind.`;

/** Pull of `branch`, not checked out, which diverged from its upstream: only a pull in its work tree rebases or merges. */
export const divergedNotice = (branch: string, upstream: string, ahead: number, behind: number): string =>
  `${divergedFrom(refName(branch), upstream, ahead, behind)} Switch to ${refName(branch)} to rebase or merge.`;

/** Push of `branch` whose upstream (on `remote`) has another name. */
export function pushOtherNameConfirmation(
  branch: string,
  remote: string,
  upstreamBranch: string,
): Confirmation<'new' | 'upstream'> {
  return {
    level: 'info',
    message: `${refName(branch)} tracks ${refName(`${remote}/${upstreamBranch}`)}, which has another name.`,
    detail: '',
    buttons: [
      { id: 'new', label: `Push to new ${refName(`${remote}/${branch}`)}` },
      { id: 'upstream', label: `Push to ${refName(`${remote}/${upstreamBranch}`)}` },
    ],
  };
}

/** A push the remote refused because it has `count` commits `branch` lacks (counted after fetching them). */
export const pushRejected = (upstream: string, branch: string, count: number): string =>
  `${refName(upstream)} has ${plural(count, 'commit')} that ${refName(branch)} doesn't have.`;

/** VS Code's setting that allows force pushes, as Settings finds it. */
export const FORCE_PUSH_SETTING = 'git.allowForcePush';

/** Opens FORCE_PUSH_SETTING in Settings: offered after a rejected push while force pushes are off. */
export const OPEN_SETTINGS = 'Open Settings';

/** Under a warning that a force push will be needed, while FORCE_PUSH_SETTING is off. */
const FORCE_PUSH_NEEDS_SETTING = `Force pushes are off: the ${FORCE_PUSH_SETTING} setting allows them.`;

const FORCE_PUSH_OFF = `A branch you rewrote needs a force push instead: the ${FORCE_PUSH_SETTING} setting allows it.`;

/**
 * The question after a rejected push, saying only what the offered answers do: Pull (`canPull`,
 * the branch is the current one), a force push (`canForce`, FORCE_PUSH_SETTING) or, without it,
 * the setting. Undefined when the branch is neither current nor forceable: pushRejectedNotice
 * says so instead.
 */
export function pushRejectedConfirmation(
  upstream: string,
  branch: string,
  count: number,
  canPull: boolean,
  canForce: boolean,
): Confirmation<'pull' | 'force' | 'settings'> | undefined {
  if (!canPull && !canForce) return undefined;
  const them = count === 1 ? 'it' : 'them';
  return {
    level: 'info',
    message: pushRejected(upstream, branch, count),
    detail: [
      ...(canPull ? [`Pulling brings ${them} into ${refName(branch)}, then you can push.`] : []),
      canForce ? `A force push removes ${them} from ${refName(upstream)}.` : FORCE_PUSH_OFF,
    ].join('\n'),
    buttons: [
      ...(canPull ? [{ id: 'pull' as const, label: 'Pull' }] : []),
      canForce
        ? { id: 'force' as const, label: 'Force Push (With Lease)...' }
        : { id: 'settings' as const, label: OPEN_SETTINGS },
    ],
  };
}

/** A rejected push of a branch that is not the current one, with force pushes turned off. */
export const pushRejectedNotice = (upstream: string, branch: string, count: number): string =>
  `${pushRejected(upstream, branch, count)} Switch to ${refName(branch)} and pull ${count === 1 ? 'it' : 'them'} first. ${FORCE_PUSH_OFF}`;

export function forcePushConfirmation(
  branch: string,
  remote: string,
  upstream: string,
  count: number,
  newest: string | undefined,
): Confirmation<'force'> {
  return {
    message: `Force push ${refName(branch)} to ${refName(remote)}?`,
    detail: [
      `Removes ${plural(count, 'commit')} ${refName(branch)} doesn't have from ${refName(upstream)}${newest === undefined ? '' : `, newest "${newest}"`}.`,
      "Strata can't undo this.",
      `Nothing is pushed if ${refName(upstream)} changed since Strata read it.`,
    ].join('\n'),
    buttons: [{ id: 'force', label: 'Force Push' }],
  };
}

/**
 * Deleting `branch` from `remote` (its remote-tracking branch is `name`). `unreachable`: the
 * commits on no other ref once it is gone, newest first. `tracking`: local branches tracking it.
 * `moved`: it was fetched again because the remote had it elsewhere.
 */
export function deleteRemoteBranchConfirmation(
  remote: string,
  branch: string,
  name: string,
  tip: CommitRef,
  unreachable: CommitRef[],
  tracking: readonly string[],
  moved: boolean,
): Confirmation<'delete'> {
  const newest = unreachable[0];
  const n = unreachable.length;
  const tracks =
    tracking.length === 0
      ? []
      : [
          tracking.length === 1
            ? `Local branch ${refName(tracking[0]!)} tracks it and stays.`
            : `Local branches ${fileList(tracking.map(refName))} track it and stay.`,
        ];
  return {
    message: newest
      ? `Delete branch ${refName(branch)} from ${refName(remote)} and its ${plural(n, 'unmerged commit')}?`
      : `Delete branch ${refName(branch)} from ${refName(remote)}?`,
    detail: [
      `${moved ? `${refName(name)} changed on ${refName(remote)} since the last fetch. ` : ''}${
        newest
          ? `${plural(n, 'commit')} would be on no branch, newest ${commitName(newest)}.`
          : `${refName(name)} points at ${commitName(tip)}, which another branch or tag has too.`
      }`,
      "Strata can't undo this.",
      ...tracks,
    ].join('\n'),
    buttons: [{ id: 'delete', label: newest ? 'Delete Remote Branch and Commits' : 'Delete Remote Branch' }],
  };
}

export const publishPick = (branch: string): string => `Publish ${refName(branch)} to…`;
export const setUpstreamPick = (branch: string): string => `Set the upstream of ${refName(branch)} to…`;
export const noUpstreamCandidate = (branch: string): string =>
  `There is no other remote branch to set as the upstream of ${refName(branch)}.`;
export const pushTagPick = (tag: string): string => `Push tag ${refName(tag)} to…`;

export const deleteRemoteTagPick = (tag: string): string => `Delete tag ${refName(tag)} from…`;

export function deleteRemoteTagConfirmation(tag: string, remote: string, at: CommitRef): Confirmation<'delete'> {
  return {
    message: `Delete tag ${refName(tag)} from ${refName(remote)}?`,
    detail: [`The local tag stays at ${commitName(at)}.`, "Strata can't undo this."].join('\n'),
    buttons: [{ id: 'delete', label: 'Delete Remote Tag' }],
  };
}

export const tagExistsOnRemote = (tag: string, remote: string): string =>
  `${refName(remote)} already has a different tag ${refName(tag)}; nothing was pushed.`;

export const REMOTE_DONE = {
  fetched: (remote: string | undefined): string => `Fetched ${remote === undefined ? 'all remotes' : refName(remote)}`,
  published: (branch: string, remote: string): string => `Published ${refName(branch)} to ${refName(remote)}`,
  pushed: (branch: string, upstream: string): string => `Pushed ${refName(branch)} to ${refName(upstream)}`,
  forcePushed: (branch: string, upstream: string): string => `Force pushed ${refName(branch)} to ${refName(upstream)}`,
  remoteBranchDeleted: (branch: string, remote: string): string =>
    `Deleted branch ${refName(branch)} from ${refName(remote)}`,
  tagPushed: (tag: string, remote: string): string => `Pushed tag ${refName(tag)} to ${refName(remote)}`,
  remoteTagDeleted: (tag: string, remote: string): string => `Deleted tag ${refName(tag)} from ${refName(remote)}`,
  remoteBranchGone: (name: string, remote: string): string =>
    `${refName(name)} was already gone from ${refName(remote)}`,
  upstreamUnset: (branch: string): string => `Unset the upstream of ${refName(branch)}`,
  upstreamSet: (branch: string, upstream: string): string =>
    `Set the upstream of ${refName(branch)} to ${refName(upstream)}`,
  upToDate: 'Already up to date',
};

export const REMOTE_DOING = {
  fetching: (remote: string | undefined): string =>
    `Fetching ${remote === undefined ? 'all remotes' : refName(remote)}`,
  pushing: (branch: string, dest: string): string => `Pushing ${refName(branch)} to ${refName(dest)}`,
  publishing: (branch: string, remote: string): string => `Publishing ${refName(branch)} to ${refName(remote)}`,
  pushingTag: (tag: string, remote: string): string => `Pushing tag ${refName(tag)} to ${refName(remote)}`,
  deletingTag: (tag: string, remote: string): string => `Deleting tag ${refName(tag)} from ${refName(remote)}`,
  deletingBranch: (branch: string, remote: string): string => `Deleting ${refName(branch)} from ${refName(remote)}`,
  unsettingUpstream: (branch: string): string => `Unsetting the upstream of ${refName(branch)}`,
  settingUpstream: (branch: string, upstream: string): string =>
    `Setting the upstream of ${refName(branch)} to ${refName(upstream)}`,
  fastForwarding: (branch: string, upstream: string): string =>
    `Fast-forwarding ${refName(branch)} to ${refName(upstream)}`,
};

/** Why a diverged pull offers less than Rebase and Merge, or rebases differently than configured. */
export const PULL_NOTES = {
  ffOnly: 'Merging needs pull.ff other than "only".',
  rebaseMerges: 'Rebase replays the commits of its merges one by one instead of keeping the merges.',
};

/** The two picks behind Branch and Tag Actions...: which ref, then which of its menu's commands. */
export const REF_ACTIONS = {
  title: 'Branch and Tag Actions',
  kind: { branch: 'branch', remote: 'remote branch', tag: 'tag' } as Record<RefKind, string>,
  actionsFor: (name: string): string => `Actions for ${refName(name)}`,
};

/** What the graph says about the history of a file or folder. */
export const PATH_HISTORY = {
  /** The toolbar status while the history is read: `n` commits that change `path` found so far. */
  searching: (path: string, n: number): string =>
    n === 0 ? `Searching history of ${path}…` : `Searching history of ${path}: ${plural(n, 'commit')} so far`,
  /** The toolbar status once all of it is read. */
  found: (path: string, n: number): string =>
    n === 0 ? `No commit changes ${path}` : `${plural(n, 'commit')} change${n === 1 ? 's' : ''} ${path}`,
  notTracked: (path: string): string => `${path} is not tracked by git`,
  /** The chip popover's line under the full path: what was found, and the rename the history starts with. */
  summary: (n: number, done: boolean, renamed: { from: string; short: string } | undefined): string =>
    !done
      ? `Searching: ${plural(n, 'commit')} so far.`
      : `${n === 0 ? 'No commit changes' : `${plural(n, 'commit')} change${n === 1 ? 's' : ''}`} it.${
          renamed ? ` Renamed from ${renamed.from} in ${renamed.short}.` : ''
        }`,
  /** Note on a commit kept although it leaves the paths alone (a ref tip, a joining merge). */
  unchanged: (name: string): string => `no change to ${name}`,
  include: (path: string): string => `Include ${path}`,
  folderHistory: (folder: string): string => `Show History of ${folder}`,
  /** A partial clone's history that starts where the path was added: renames that changed the content were not looked for. */
  exactOnly:
    'Renames that change the file are not looked for in a partial clone: its contents are downloaded on demand.',
} as const;

const KEEP_GRAPH = 'Write and Keep Updated';

/** A read of history that took long enough to offer a commit-graph. */
export type SlowRead = 'history' | 'paths' | 'find';

/** The offer to write a commit-graph when history is slow to load. */
export const COMMIT_GRAPH_OFFER = {
  keep: KEEP_GRAPH,
  /** After the offer's buttons: asks again in the next window, or never. */
  later: 'Not Now',
  never: "Don't Ask Again",
  /**
   * The repository has none, and what was slow: the history, a file or folder history (which also
   * needs filters) or a search.
   */
  graph: (repo: string, slow: SlowRead): { message: string; buttons: string[] } => ({
    message:
      slow === 'paths'
        ? `History of ${repo} loads slowly because the repository has no commit-graph. Writing one with ` +
          'changed-path filters (git commit-graph write --reachable --changed-paths) makes the graph and ' +
          'file history open in a fraction of the time. Kept updated, it also covers new commits as they come in.'
        : slow === 'find'
          ? `Searching ${repo} is slow because the repository has no commit-graph. Writing one ` +
            '(git commit-graph write --reachable) shows the first matches of most searches at once and makes ' +
            'the graph open in a fraction of the time. Kept updated, it also covers new commits as they come in.'
          : `History of ${repo} loads slowly because the repository has no commit-graph. Writing one ` +
            '(git commit-graph write --reachable) makes the graph open in a fraction of the time. Kept updated, ' +
            'it also covers new commits as they come in.',
    buttons: [KEEP_GRAPH, 'Write Once'],
  }),
  /** It has one without changed-path filters, and the history of `path` was slow. */
  filters: (path: string): { message: string; buttons: string[] } => ({
    message:
      `History of ${path} is slow to search because the commit-graph has no changed-path filters. ` +
      'Writing them (git commit-graph write --reachable --changed-paths) makes file and folder history ' +
      'several times faster; new commits keep them.',
    buttons: ['Write Filters'],
  }),
} as const;
/** What a commit rewrite (Edit) does, as its confirmation and the message editor tell it. */
export interface RewriteFacts {
  edit: EditKind;
  /** HEAD's branch (refName) or HEAD. */
  branch: string;
  /** The commits the edit names, as the question names them: "b7699a1", "3 commits", "99f707e into b7699a1". */
  what: string;
  /** Newer commits replayed on top of the edited ones. */
  onTop: number;
  /** Rewritten commits a remote-tracking branch has, and that branch (short name); `canForce`: FORCE_PUSH_SETTING is on. */
  pushed: { count: number; remote: string; canForce: boolean } | undefined;
  /** Short names of the branches that can move with the rewritten commits. */
  moves: readonly string[];
  stays: readonly { name: string; why: StayReason }[];
}

const EDIT_VERB: Record<EditKind, string> = {
  reword: 'Save',
  squash: 'Squash',
  fixup: 'Fix Up',
  drop: 'Drop',
  reorder: 'Reorder',
};

const QUESTION: Record<EditKind, (f: RewriteFacts) => string> = {
  reword: (f) => `Save the new message of ${f.what}?`,
  squash: (f) => `Squash ${f.what} on ${f.branch}?`,
  fixup: (f) => `Fix up ${f.what}?`,
  drop: (f) => `Drop ${f.what} from ${f.branch}?`,
  reorder: (f) => `Reorder ${f.what} on ${f.branch}?`,
};

const names = (refs: readonly string[]) => fileList(refs.map(refName));
const isAre = (n: number) => (n === 1 ? 'is' : 'are');

const STAY: Record<StayReason, (names: string, one: boolean) => string> = {
  tag: (n, one) => `${one ? 'Tag' : 'Tags'} ${n} ${one ? 'stays' : 'stay'} on the old commits.`,
  worktree: (n, one) =>
    `${n} ${one ? 'is' : 'are'} checked out in another worktree and ${one ? 'keeps' : 'keep'} the old commits.`,
  old: (n, one) => `${n} ${one ? 'keeps' : 'keep'} the old commits.`,
  forked: (n, one) => `${n} branched off the rewritten commits and ${one ? 'keeps' : 'keep'} the old ones.`,
};

const staySentences = (stays: RewriteFacts['stays']): string[] =>
  (Object.keys(STAY) as StayReason[]).flatMap((why) => {
    const refs = stays.filter((s) => s.why === why).map((s) => s.name);
    return refs.length === 0 ? [] : [STAY[why](names(refs), refs.length === 1)];
  });

/** The line under the message editor: what saving rewrites and moves. */
export function rewriteEffects(f: RewriteFacts): string {
  const keep = f.stays.map((s) => s.name);
  return [
    f.onTop === 0
      ? 'No newer commit is rewritten'
      : `${plural(f.onTop, 'newer commit')} ${isAre(f.onTop)} rewritten on top`,
    f.pushed
      ? `${plural(f.pushed.count, 'commit')} ${isAre(f.pushed.count)} on ${refName(f.pushed.remote)} already`
      : 'Nothing was pushed',
    f.moves.length > 0
      ? `${names(f.moves)} ${f.moves.length === 1 ? 'moves' : 'move'} along`
      : keep.length === 0
        ? 'no other branch moves'
        : '',
    keep.length > 0 ? `${names(keep)} ${keep.length === 1 ? 'keeps' : 'keep'} the old commits` : '',
  ]
    .filter((s) => s !== '')
    .join(' · ');
}

/** An answer to a rewrite's confirmation: move the branches on it along, or not; or what to do with changes. */
export type RewriteAnswer = 'move' | 'only' | StashChoice;

/**
 * The question before a rewrite, or undefined when nothing needs asking: no commit was pushed,
 * no other ref is on them, and no uncommitted changes are in the way (`section`, `stash`). A drop
 * always asks.
 */
export function rewriteConfirmation(
  f: RewriteFacts,
  dirty?: { section: string; choices: readonly StashChoice[] },
): Confirmation<RewriteAnswer> | undefined {
  const asks =
    f.edit === 'drop' || f.pushed !== undefined || f.moves.length > 0 || f.stays.length > 0 || dirty !== undefined;
  if (!asks) return undefined;
  const verb = EDIT_VERB[f.edit];
  const p = f.pushed;
  const pushed = p && [
    `${refName(p.remote)} has ${p.count === 1 ? 'one' : p.count} of them: pushing ${f.branch} afterwards needs a force push, and anyone who fetched ${p.count === 1 ? 'it' : 'them'} keeps the old ${p.count === 1 ? 'commit' : 'commits'}.`,
  ];
  const moveLabel =
    f.moves.length === 1 ? `${verb} and Move ${f.moves[0]!}` : `${verb} and Move ${f.moves.length} Branches`;
  const buttons: { id: RewriteAnswer; label: string }[] = dirty
    ? stashButtons('rebase', dirty.choices, verb)
    : f.moves.length > 0
      ? [
          { id: 'move', label: moveLabel },
          { id: 'only', label: `${verb} Only` },
        ]
      : [{ id: 'only', label: p ? `${verb} Anyway` : verb }];
  return {
    ...(p ? {} : { level: 'info' as const }),
    message: p ? `Rewrite ${plural(p.count, 'commit')} that ${refName(p.remote)} already has?` : QUESTION[f.edit](f),
    detail: [
      ...(p ? [QUESTION[f.edit](f)] : []),
      f.onTop > 0 ? `Replays ${plural(f.onTop, 'newer commit')} on top.` : '',
      ...(pushed ?? []),
      p && !p.canForce ? FORCE_PUSH_NEEDS_SETTING : '',
      f.moves.length > 0
        ? `${names(f.moves)} ${isAre(f.moves.length)} on the rewritten commits: ${moveLabel} moves ${f.moves.length === 1 ? 'it' : 'them'} to the new ones.`
        : '',
      ...staySentences(f.stays),
      'Undo restores the original commits.',
      dirty?.section ?? '',
    ]
      .filter((s) => s !== '')
      .join('\n'),
    buttons,
  };
}

/** Why Strata can't carry out an edit of commit `short` on `branch` (refName or HEAD). */
export function rewriteRefused(r: Refusal, short: string, branch: string): string {
  switch (r) {
    case 'notOnHeadLine':
      return `${short} is not on the first-parent line of ${branch} near HEAD, so Strata can't rewrite it.`;
    case 'merge':
      return `A merge commit is between ${short} and HEAD; Strata rewrites only commits with no merge above them.`;
    case 'noParent':
      return `${short} is the first commit; it has no parent to fix up into.`;
    case 'order':
      return `The commits are not in order on ${branch}.`;
    case 'emptyMessage':
      return 'The commit message is empty.';
    case 'nothingLeft':
      return `Dropping every commit would leave ${branch} with none.`;
    case 'unchanged':
      return `The commits of ${branch} are in that order already; nothing was reordered.`;
  }
}

/** Longer messages than this are refused: Windows limits a command line to 32,767 characters. */
export const MESSAGE_LIMIT = 30_000;

export const messageTooLong = (length: number): string =>
  `The message has ${length.toLocaleString('en-US')} characters; Strata writes messages of up to ${MESSAGE_LIMIT.toLocaleString('en-US')}.`;

/** The editor was opened at HEAD `short`, and HEAD has moved since. */
export const editOutdated = (branch: string): string =>
  `${branch} changed since the editor opened; nothing was rewritten and your message is kept.`;

/** Apply in the reorder mode entered at another HEAD than `branch` (refName or HEAD) has now. */
export const reorderOutdated = (branch: string): string =>
  `${branch} changed since the reorder started; nothing was reordered.`;

/** Reorder Commits... where HEAD's line has fewer than two commits down to its first merge. */
export const nothingToReorder = (branch: string): string =>
  `${branch} has fewer than two commits above its last merge, so there is nothing to reorder.`;

export const fixupPick = (c: CommitRef): { title: string; placeholder: string } => ({
  title: `Fix Up ${commitName(c)} into…`,
  placeholder: 'The older commit its changes belong to',
});

/** What Undo calls a rewrite: "Undid the squash". */
export const REWRITE_UNDO: Record<EditKind, string> = {
  reword: 'message edit',
  squash: 'squash',
  fixup: 'fixup',
  drop: 'drop',
  reorder: 'reorder',
};

export const REWRITE_DOING = {
  reword: (short: string): string => `Editing the message of ${short}`,
  squash: (n: number): string => `Squashing ${plural(n, 'commit')}`,
  fixup: (short: string, into: string): string => `Fixing up ${short} into ${into}`,
  drop: (n: number, branch: string): string => `Dropping ${plural(n, 'commit')} from ${branch}`,
  reorder: (n: number, branch: string): string => `Reordering ${plural(n, 'commit')} on ${branch}`,
};

/** `moved`: the other branches that moved along (short names). */
export const REWRITE_DONE = {
  reword: (short: string, now: string): string => `Edited the message of ${short} (now ${now})`,
  squash: (n: number, now: string): string => `Squashed ${n} commits into ${now}`,
  fixup: (short: string, into: string): string => `Fixed up ${short} into ${into}`,
  drop: (n: number, branch: string): string => `Dropped ${plural(n, 'commit')} from ${branch}`,
  reorder: (n: number, branch: string): string => `Reordered ${plural(n, 'commit')} on ${branch}`,
  moved: (done: string, moved: readonly string[]): string =>
    moved.length === 0 ? done : `${done}; moved ${names(moved)} along`,
};

/** Branches a rewrite could not move along: they moved meanwhile. */
export const notMovedAlong = (done: string, branches: readonly string[]): string =>
  `${done}. ${names(branches)} moved meanwhile and ${branches.length === 1 ? 'keeps' : 'keep'} the old commits.`;

/** A rewrite (`kind`) of `what` (RewriteFacts.what), as "untracked files in the way of the …" names it. */
export const rewriteInTheWay = (kind: EditKind, what: string): string => `${REWRITE_UNDO[kind]} of ${what}`;

/** Undo of a rewrite found `name` (refName or HEAD) moved since. */
export const undoRewriteOutdated = (label: string, name: string): string =>
  `${name} has moved since the ${label}, so Undo would lose what came after; nothing was done.`;

/** Shift-click in a file or folder history, whose rows skip the commits that leave the path alone. */
export const TIDY_WHOLE_HISTORY =
  'Selecting commits to squash or drop needs the whole history: clear the path filter first.';

/** The graph tab's title: the shown repository's name, Strata before there is one. */
export const graphTitle = (repo: string | undefined): string => repo ?? 'Strata';
