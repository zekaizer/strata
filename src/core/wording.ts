import type { DirtyFacts, StashChoice, StashChoices, StashOp } from './autostash.ts';
import { MORE_HISTORY, type ResetMode } from './operations.ts';
import type { RefKind } from './refs.ts';
import type { OperationKind } from './repo-state.ts';

/** A commit as confirmations name it. */
export interface CommitRef {
  short: string;
  subject: string;
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

const quoted = (commits: readonly CommitRef[], shown = 2): string => {
  const names = commits.slice(0, shown).map((c) => `"${c.subject}"`);
  const rest = commits.length - names.length;
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

/** The closing section of every confirmation that finds uncommitted changes. */
/**
 * `overwritten`: for a hard reset, the untracked files at paths it restores (they would be
 * overwritten, so the "stay in place" sentence would be false).
 */
export function dirtySection(
  dirty: DirtyFacts,
  choices: StashChoices,
  submodules: number,
  overwritten?: readonly string[],
): string {
  const staged = dirty.staged > 0 ? ` (${dirty.staged} staged)` : '';
  return [
    `Uncommitted changes: ${plural(dirty.files, 'file')}${staged}.`,
    choices.explain,
    overwritten === undefined
      ? 'Untracked files are not stashed; they stay in place.'
      : overwritten.length > 0
        ? `${plural(overwritten.length, 'untracked file')} at paths the reset restores would be overwritten (${fileList(overwritten)}); stashing takes them too.`
        : '',
    ...(submodules > 0
      ? [`Changes inside ${plural(submodules, 'submodule')} are not stashed (git never stashes them).`]
      : []),
  ]
    .filter((s) => s !== '')
    .join(' ');
}

export interface ResetFacts {
  /** Branch being reset; undefined when HEAD is detached. */
  branch: string | undefined;
  target: CommitRef;
  /** Commits that leave the branch, newest first. */
  dropped: CommitRef[];
  /** Commits the branch gains (reset to a commit on another line). */
  gained: number;
  /** Of the dropped commits: how many are on the upstream, and how many on no other ref. */
  onUpstream: number;
  unreachable: number;
  upstream: string | undefined;
  dirtyFiles: number;
}

const MODE_LINE: Record<ResetMode, (dirtyFiles: number) => string> = {
  soft: () => 'Their changes stay staged.',
  mixed: () => 'Their changes stay in your files, unstaged.',
  keep: () => 'Your uncommitted changes are kept.',
  hard: (n) =>
    n > 0
      ? `Their changes are discarded. Your uncommitted changes in ${plural(n, 'file')}: Stash Changes & Reset keeps them in the stash list; Discard Changes & Reset throws them away.`
      : 'Their changes are discarded.',
};

/** Asks only when commits leave the branch or work is discarded, or when `ask` (changes need an answer). */
export function resetConfirmation(f: ResetFacts, mode: ResetMode, ask = false): Confirmation<'reset'> | undefined {
  if (!ask && f.dropped.length === 0 && !(mode === 'hard' && f.dirtyFiles > 0)) return undefined;
  const name = f.branch === undefined ? 'HEAD' : `'${f.branch}'`;
  const n = f.dropped.length;
  const moves =
    n === 0
      ? `${name} stays at ${f.target.short}.`
      : f.gained > 0
        ? `${name} moves to a commit on another line: drops ${plural(n, 'commit')} (${quoted(f.dropped)}), gains ${f.gained}.`
        : `${name} moves back ${plural(n, 'commit')}: ${quoted(f.dropped)}.`;
  const them = (k: number) => (k === 1 ? '1 of them is' : `${k} of them are`);
  return {
    message: `Reset ${name} to ${f.target.short}?`,
    detail: [
      moves,
      ...(f.onUpstream > 0 && f.upstream
        ? [
            `${them(f.onUpstream)} on ${f.upstream}; ${name} will be ${f.onUpstream} behind it (a pull brings ${f.onUpstream === 1 ? 'it' : 'them'} back).`,
          ]
        : []),
      ...(f.unreachable > 0 ? [`${them(f.unreachable)} on no other branch; Undo or the reflog can restore them.`] : []),
      MODE_LINE[mode](f.dirtyFiles),
    ].join(' '),
    buttons: [{ id: 'reset', label: `Reset ${name}` }],
  };
}

/** `unreachable`: the commits on no other branch, remote-tracking branch or tag, newest first. */
export function deleteBranchConfirmation(
  branch: string,
  tip: CommitRef,
  unreachable: CommitRef[],
  upstream: string | undefined,
): Confirmation<'delete'> {
  const remote = upstream ? ` The remote branch ${upstream} is not deleted.` : '';
  const newest = unreachable[0];
  if (!newest)
    return {
      message: `Delete branch '${branch}'?`,
      detail: `It points at ${tip.short} "${tip.subject}", which is also on another branch. No commits are lost.${remote}`,
      buttons: [{ id: 'delete', label: 'Delete Branch' }],
    };
  const n = unreachable.length;
  return {
    message: `Delete branch '${branch}' and its ${plural(n, 'unmerged commit')}?`,
    detail: `${plural(n, 'commit')} would be on no branch, newest "${newest.subject}" (${newest.short}). Undo restores the branch; otherwise only the reflog can.${remote}`,
    buttons: [{ id: 'delete', label: 'Delete Branch and Commits' }],
  };
}

/** The sentence and buttons for uncommitted changes an Abort or Skip (`verb`) would discard (`paths`). */
function discardedChanges(
  verb: 'Abort' | 'Skip',
  paths: readonly string[],
): { line: string; buttons: { id: 'stash' | 'discard'; label: string }[] } {
  return {
    line: `Your uncommitted changes in ${plural(paths.length, 'file')} (${fileList(paths)}) would be discarded: Stash Changes & ${verb} keeps them in the stash list; Discard Changes & ${verb} throws them away.`,
    buttons: [
      { id: 'stash', label: `Stash Changes & ${verb}` },
      { id: 'discard', label: `Discard Changes & ${verb}` },
    ],
  };
}

/** `discards`: paths with uncommitted changes the abort would throw away (readDiscardedByAbort). */
export function abortConfirmation(
  op: OperationKind,
  branch: string | undefined,
  back: string,
  autostash: boolean,
  discards: readonly string[] = [],
): Confirmation<'abort' | 'stash' | 'discard'> {
  const name = branch === undefined ? 'HEAD' : `'${branch}'`;
  const discarded = discards.length > 0 ? discardedChanges('Abort', discards) : undefined;
  return {
    message: `Abort the ${OP_NAME[op]}?`,
    detail: [
      `${name} goes back to ${back} as before the ${OP_NAME[op]}.`,
      "Conflict resolutions you've made are discarded.",
      ...(discarded ? [discarded.line] : []),
      ...(autostash ? ['Your stashed changes are restored.'] : []),
    ].join(' '),
    buttons: discarded ? discarded.buttons : [{ id: 'abort', label: `Abort ${OP_TITLE[op]}` }],
  };
}

const branchName = (branch: string | undefined) => (branch === undefined ? 'HEAD' : `'${branch}'`);

/**
 * `label` names what is undone ("merge", "branch creation"); `back` is where Undo moves HEAD;
 * `deletes`, a branch Undo deletes instead (it was created).
 */
export function undoMovedConfirmation(
  branch: string | undefined,
  label: string,
  now: string,
  back: string,
  deletes?: string,
): Confirmation<'undo'> {
  return {
    message: `${branchName(branch)} has moved since the ${label} (now at ${now}).`,
    detail:
      deletes === undefined
        ? `Undo would move it back to ${back} and drop the newer commits.`
        : `Undo would switch back to ${back} and delete '${deletes}', with the commits made on it since.`,
    buttons: [{ id: 'undo', label: 'Undo Anyway' }],
  };
}

/** HEAD is on another branch than the one the operation moved, so Undo would move the wrong one. */
export const undoGone = (label: string, head: string): string =>
  `HEAD is now on ${head}, not on the branch the ${label} moved, so Undo was dropped.`;

export const undone = (label: string): string => `Undid the ${label}`;

/** A failed git command as an error notification shows it. */
export const gitFailure = (message: string): string => message.trim().split('\n').slice(0, 3).join('\n');

export const gitTooOld = (found: string): string =>
  `Strata needs git 2.27 or newer to change repositories (found ${found}).`;

/** A remote operation that git could not authenticate (auth) or whose host it does not know yet (hostKey). */
export function signInConfirmation(
  remote: string | undefined,
  kind: 'auth' | 'hostKey',
): Confirmation<'terminal' | 'output'> {
  const name = remote === undefined ? 'a remote' : `'${remote}'`;
  return {
    message: kind === 'auth' ? `Strata couldn't sign in to ${name}.` : `Strata couldn't connect to ${name}.`,
    detail:
      kind === 'auth'
        ? 'git needs credentials, and no credential helper or SSH agent provided them. Run the same command in a terminal to sign in there.'
        : 'Connect to the host once from a terminal to accept its key.',
    buttons: [
      { id: 'terminal', label: 'Run in Terminal' },
      { id: 'output', label: 'Show Output' },
    ],
  };
}

/** Progress label of Undo Last Operation. */
export const undoLabel = (label: string): string => `Undoing the ${label}`;

export const quote = (name: string): string => `'${name}'`;

/** `name`, as sentences name it, moved between the confirmation and the operation. */
export const changedMeanwhile = (name: string): string => `${name} changed while you were deciding; nothing was done.`;

/** A menu opened on a ref that is gone. */
export const staleTarget = (name: string): string => `'${name}' no longer exists; the graph has been refreshed.`;

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
export function stashButtons<C extends StashChoice>(op: StashOp, choices: readonly C[]): { id: C; label: string }[] {
  const verb = VERB[op];
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
    message: `Switching to ${to} would overwrite your changes to ${plural(overlap.length, 'file')}.`,
    detail: [
      `${fileList(overlap)}. Stash them and bring them back after switching, or let git merge them into ${to} (conflicts are possible).`,
      section,
    ]
      .filter((s) => s !== '')
      .join(' '),
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
  stashBranch: (name: string): string => `switch to the new branch '${name}'`,
};

/** The stash that moves untracked files out of the way of `op` (IN_THE_WAY_OF); Strata never pops it. */
export const inTheWayStash = (op: string): string => `Strata: untracked files in the way of ${op}`;

/** git refused `op` (IN_THE_WAY_OF) because untracked `files` are where it puts files of its own. */
export function inTheWayConfirmation(op: string, files: readonly string[]): Confirmation<'stash'> {
  const one = files.length === 1;
  return {
    message: `${plural(files.length, 'untracked file')} ${one ? 'is' : 'are'} in the way of the ${op}: ${fileList(files)}.`,
    detail: `Strata can move ${one ? 'it' : 'them'} into a stash and try again. That stash stays in the list; Strata does not bring the ${one ? 'file' : 'files'} back, because the ${op} puts its own ${one ? 'version' : 'versions'} there.`,
    buttons: [{ id: 'stash', label: one ? 'Stash It & Retry' : 'Stash Them & Retry' }],
  };
}

/** HEAD is detached on `head`, with `count` commits no ref reaches. */
export function leaveBehindConfirmation(count: number, head: CommitRef): Confirmation<'switch'> {
  return {
    message: `Leave ${plural(count, 'commit')} behind?`,
    detail: `HEAD is detached at ${head.short} with ${plural(count, 'commit')} on no branch (newest "${head.subject}"). After switching they're only reachable through the reflog.`,
    buttons: [{ id: 'switch', label: 'Switch Anyway' }],
  };
}

export const createBranchInput = (at: CommitRef): { title: string; prompt: string } => ({
  title: `Create Branch at ${at.short} "${at.subject}"`,
  prompt: 'Creates the branch and switches to it.',
});

export const createTagInput = (at: CommitRef): { title: string; prompt: string } => ({
  title: `Create Tag at ${at.short} "${at.subject}"`,
  prompt: 'Enter the tag name.',
});

export const tagMessageInput = (tag: string, at: CommitRef): { title: string; prompt: string } => ({
  title: `Create Tag '${tag}' at ${at.short}`,
  prompt: 'Message (empty for a lightweight tag)',
});

export const refExists = (kind: 'branch' | 'tag', name: string, short: string): string =>
  `A ${kind} named '${name}' already exists (at ${short}).`;

/** A rename to the name it has. */
export const NEEDS_NEW_NAME = 'Enter a different name.';

/** `remote`: the remote of the branch's upstream, whose branch keeps its name. */
export const renameInput = (branch: string, remote: string | undefined): { title: string; prompt: string } => ({
  title: `Rename Branch '${branch}'`,
  prompt: ['Enter the new name.', ...(remote === undefined ? [] : [`'${branch}' on ${remote} keeps its name.`])].join(
    ' ',
  ),
});

export function deleteTagConfirmation(tag: string, at: CommitRef): Confirmation<'delete'> {
  return {
    message: `Delete tag '${tag}'?`,
    detail: `It points at ${at.short} "${at.subject}". A tag already pushed stays on its remote, and a fetch brings it back.`,
    buttons: [{ id: 'delete', label: 'Delete Tag' }],
  };
}

export const checkedOutElsewhere = (branch: string, path: string | undefined): string =>
  `'${branch}' is checked out in another worktree${path === undefined ? '' : ` (${path})`}.`;

/** `done`: what the operation did; `paths`: the first of `count` conflicted files; `stash`: stashLabel(). */
export const popConflicted = (done: string, paths: readonly string[], count: number, stash: string): string =>
  `${done}, but restoring your stashed changes conflicted in ${plural(count, 'file')} (${fileList(paths)}). Your changes are safe in ${stash}.`;

/** A stash as messages name it: its number goes stale with the next push, its message does not. */
export const stashLabel = (index: number, message: string): string => `stash@{${index}} ("${message}")`;

export const migrateConflicted = (done: string, count: number): string =>
  `${done}; your changes conflicted in ${plural(count, 'file')}.`;

/** What a finished operation did, for the status bar and the Undo notification. */
export const DONE = {
  switched: (branch: string, behind?: { count: number; upstream: string }): string =>
    `Switched to '${branch}'${behind ? ` (${behind.count} behind ${behind.upstream})` : ''}`,
  tracking: (branch: string, upstream: string): string => `Created '${branch}' tracking '${upstream}'`,
  detached: (short: string): string => `Detached HEAD at ${short}`,
  branchCreated: (name: string, short: string): string => `Created '${name}' at ${short}`,
  tagCreated: (tag: string, short: string): string => `Created tag '${tag}' at ${short}`,
  renamed: (from: string, to: string): string => `Renamed '${from}' to '${to}'`,
  branchDeleted: (branch: string): string => `Deleted branch '${branch}'`,
  tagDeleted: (tag: string): string => `Deleted tag '${tag}'`,
  copied: (name: string): string => `Copied '${name}'`,
  copiedHash: (short: string): string => `Copied the commit hash of ${short}`,
  copiedShortHash: (short: string): string => `Copied ${short}`,
  copiedSubject: (short: string): string => `Copied the subject of ${short}`,
};

/** Progress labels: what is running. `to` is named as in a sentence (a quoted branch or a short id). */
export const DOING = {
  switching: (to: string): string => `Switching to ${to}`,
  creatingBranch: (name: string): string => `Creating branch '${name}'`,
  creatingTag: (tag: string): string => `Creating tag '${tag}'`,
  renaming: (branch: string): string => `Renaming '${branch}'`,
  deletingBranch: (branch: string): string => `Deleting branch '${branch}'`,
  deletingTag: (tag: string): string => `Deleting tag '${tag}'`,
};

/** Run in Terminal could not quote the command for the terminal's shell; `line` is quoted for a POSIX shell. */
export const commandUnquotable = (line: string): string =>
  `Strata can't quote this command safely for your terminal's shell. Run it there yourself, quoted for that shell: ${line}`;

const OP_SENTENCE: Record<OperationKind, string> = {
  rebase: 'Rebase',
  merge: 'Merge',
  cherryPick: 'Cherry pick',
  revert: 'Revert',
};

export interface MergeFacts {
  /** The source and the branch merged into, as sentences name them (quoted, or a short id / HEAD). */
  src: string;
  into: string;
  /** The source commit, and how many commits the merge brings. */
  short: string;
  count: number;
  canFastForward: boolean;
}

/**
 * Clean: Fast-Forward or Create Merge Commit (merge commit first when merge.ff is false), or just
 * Merge. Dirty: the stash `buttons`, merging as `mode` says.
 */
export function mergeConfirmation(
  f: MergeFacts,
  mergeFf: boolean | undefined,
  dirty?: { section: string; buttons: { id: StashChoice; label: string }[]; mode: 'ff' | 'noFastForward' },
): Confirmation<'ff' | 'noFastForward' | StashChoice> {
  const commits = plural(f.count, 'commit');
  const fastForwards = `${f.into} fast-forwards to ${f.short} (${commits}).`;
  const records = `Creates a merge commit on ${f.into} with ${commits} from ${f.src}.`;
  const message = `Merge ${f.src} into ${f.into}?`;
  if (dirty)
    return {
      message,
      detail: [f.canFastForward && dirty.mode === 'ff' ? fastForwards : records, dirty.section].join(' '),
      buttons: dirty.buttons,
    };
  if (!f.canFastForward) return { message, detail: records, buttons: [{ id: 'ff', label: 'Merge' }] };
  const both: { id: 'ff' | 'noFastForward'; label: string }[] = [
    { id: 'ff', label: 'Fast-Forward' },
    { id: 'noFastForward', label: 'Create Merge Commit' },
  ];
  return {
    message,
    detail: `${f.into} can fast-forward to ${f.short} (${commits}), or record a merge commit.`,
    buttons: mergeFf === false ? both.reverse() : both,
  };
}

export interface RebaseFacts {
  branch: string;
  onto: string;
  ontoShort: string;
  /** Commits git replays (merges dropped, patches already upstream skipped). */
  replay: number;
  merges: number;
  /** Of the replayed commits, how many are on the upstream. */
  onUpstream: number;
  upstream: string | undefined;
}

export function rebaseConfirmation<B extends string>(
  f: RebaseFacts,
  section: string,
  buttons: { id: B; label: string }[],
): Confirmation<B> {
  const them = f.onUpstream === 1 ? '1 of them is' : `${f.onUpstream} of them are`;
  return {
    message: `Rebase ${f.branch} onto ${f.onto}?`,
    detail: [
      `Replays ${plural(f.replay, 'commit')} of ${f.branch} on top of ${f.onto} (${f.ontoShort}).`,
      ...(f.merges > 0
        ? [
            `${plural(f.merges, 'merge commit')} ${f.merges === 1 ? 'is' : 'are'} dropped; the commits they brought in are replayed one by one.`,
          ]
        : []),
      ...(f.onUpstream > 0 && f.upstream ? [`${them} on ${f.upstream}: you'll need to force push afterwards.`] : []),
      'Undo restores the original commits.',
      section,
    ]
      .filter((s) => s !== '')
      .join(' '),
    buttons,
  };
}

/** Cherry pick or revert of `c` on `onto` (a quoted branch, or HEAD). */
export function pickConfirmation<B extends string>(
  kind: 'cherryPick' | 'revert',
  c: CommitRef,
  onto: string,
  detached: boolean,
  section: string,
  buttons: { id: B; label: string }[],
): Confirmation<B> {
  return {
    message:
      kind === 'cherryPick'
        ? `Cherry pick ${c.short} "${c.subject}" onto ${onto}?`
        : `Revert ${c.short} "${c.subject}" on ${onto}?`,
    detail: [detached ? 'HEAD is detached: the new commit will be on no branch.' : '', section]
      .filter((s) => s !== '')
      .join(' '),
    buttons,
  };
}

export const alreadyContains = (into: string, what: string): string => `${into} already contains ${what}.`;
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
  title: `Reset ${branch} to ${target.short} "${target.subject}"`,
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

export const abortButton = (kind: OperationKind): string => `Abort ${OP_TITLE[kind]}...`;

/** Continue while files still have conflicts. */
export function stillConflicted(paths: readonly string[], count: number): Confirmation<'scm'> {
  return {
    message: `${plural(count, 'file')} still ${count === 1 ? 'has' : 'have'} conflicts: ${fileList(paths)}.`,
    detail: 'Resolve and stage them first.',
    buttons: [{ id: 'scm', label: 'Open Source Control' }],
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
    message: `Skip ${c.short} "${c.subject}"?`,
    detail: [`Its changes won't be in ${branch}.`, ...(discarded ? [discarded.line] : [])].join(' '),
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
    detail: 'Resolve them before starting another operation.',
    buttons: [{ id: 'resolve', label: 'Resolve...' }],
    level: 'info',
  };
}

/** Two lines to merge share no commit in this repository. */
export const UNRELATED = 'These histories have no commit in common here.';

/** What a shallow clone can fetch of its history: MORE_HISTORY commits further back, or all of it. */
export type HistoryFetch = 'deepen' | 'unshallow';

const FETCH_HISTORY = {
  detail: `Fetch More History goes ${MORE_HISTORY} commits further back; Fetch Full History fetches the whole history. Then try again.`,
  buttons: [
    { id: 'deepen', label: 'Fetch More History' },
    { id: 'unshallow', label: 'Fetch Full History' },
  ],
} satisfies Pick<Confirmation<HistoryFetch>, 'detail' | 'buttons'>;

/** A shallow clone lacks the commits an operation needs. */
export function shallowConfirmation(a: string, b: string): Confirmation<HistoryFetch> {
  return { message: `This clone is shallow: ${a} and ${b} have no common commit in it.`, ...FETCH_HISTORY };
}

/** `short` is a commit a shallow clone has without its parent; `path`: the one file of it asked about. */
export function shallowEdgeConfirmation(short: string, path?: string): Confirmation<HistoryFetch> {
  const changes = path === undefined ? 'its changes' : `its changes to ${path}`;
  return {
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
  picked: (short: string, onto: string): string => `Cherry-picked ${short} onto ${onto}`,
  reverted: (short: string): string => `Reverted ${short}`,
  reset: (branch: string, short: string, stash: string | undefined): string =>
    `Reset ${branch} to ${short}${stash === undefined ? '' : `. Your uncommitted changes are in ${stash}`}`,
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
  fetchingHistory: {
    deepen: `Fetching ${MORE_HISTORY} more commits of history`,
    unshallow: 'Fetching the full history',
  } satisfies Record<HistoryFetch, string>,
};

/** Restoring stashed changes after `done` applied only part of them (git kept the stash). */
export const popPartial = (done: string, stash: string): string =>
  `${done}, but only part of your stashed changes came back (git could not restore some files). The rest is safe in ${stash}.`;

/** git refused to restore stashed changes after `done`; nothing was applied. */
export const popRefused = (done: string, reason: string, stash: string): string =>
  `${done}, but git could not restore your stashed changes: ${reason} They're safe in ${stash}.`;

/** Why git did not apply its autostash, for popRefused: local changes to `paths` (none known: unnamed). */
export const autostashRefused = (paths: readonly string[]): string =>
  `they would overwrite your changes${paths.length > 0 ? ` to ${fileList(paths)}` : ''}.`;

export const OPEN_SCM = 'Open Source Control View';

export const NOTHING_TO_STASH = 'No local changes to stash.';

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
  const on = `${base.short} "${base.subject}"`;
  const holds =
    files === undefined
      ? `Made on ${on}.`
      : `${plural(files.changed, 'changed file')}${files.untracked > 0 ? ` and ${files.untracked} untracked` : ''} on ${on}.`;
  return {
    message: `Drop ${stashLabel(index, message)}?`,
    detail: `${holds} Undo brings it back as stash@{0}; after that only git fsck can find it.`,
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
  return `Created '${name}' from ${label}, but ${fileList(files)} did not come back because ${one ? 'it already exists' : 'they already exist'} here. The stash is kept.`;
}

export const stashBranchInput = (index: number, message: string, short: string): { title: string; prompt: string } => ({
  title: `Create Branch from ${stashLabel(index, message)}`,
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
  branched: (name: string, label: string): string => `Created '${name}' from ${label} and applied it`,
};

export const STASH_DOING = {
  stashing: 'Stashing changes',
  applying: (label: string): string => `Applying ${label}`,
  popping: (label: string): string => `Popping ${label}`,
  dropping: (label: string): string => `Dropping ${label}`,
  branching: (name: string): string => `Creating '${name}' from a stash`,
};

export const NO_REMOTE = 'This repository has no remote.';

export const noUpstream = (branch: string): string => `'${branch}' has no upstream branch.`;

/** A detached HEAD has no branch to pull into or push. */
export const detachedNoBranch = (action: 'pull' | 'push'): string =>
  `HEAD is detached: switch to a branch to ${action}.`;

/** Pull of a branch that diverged from its upstream; `allowed`: what config permits, `note` says why not. */
export function divergedConfirmation(
  branch: string,
  upstream: string,
  ahead: number,
  behind: number,
  allowed: { rebase: boolean; merge: boolean },
  note: string | undefined,
): Confirmation<'rebase' | 'merge'> {
  return {
    message: `${branch} and '${upstream}' have diverged (${ahead} and ${behind} commits).`,
    detail: note ?? 'Rebase replays its commits on top of the upstream; Merge records a merge commit.',
    buttons: [
      ...(allowed.rebase ? [{ id: 'rebase' as const, label: 'Rebase' }] : []),
      ...(allowed.merge ? [{ id: 'merge' as const, label: 'Merge' }] : []),
    ],
  };
}

/** Push of `branch` whose upstream (on `remote`) has another name. */
export function pushOtherNameConfirmation(
  branch: string,
  remote: string,
  upstreamBranch: string,
): Confirmation<'new' | 'upstream'> {
  return {
    message: `'${branch}' tracks ${remote}/${upstreamBranch}, which has another name.`,
    detail: `Push it to a branch of its own, or update ${remote}/${upstreamBranch} with it.`,
    buttons: [
      { id: 'new', label: `Push to new '${remote}/${branch}'` },
      { id: 'upstream', label: `Push to '${remote}/${upstreamBranch}'` },
    ],
  };
}

/** A push the remote refused because it has commits `branch` lacks (counted after fetching them). */
export function pushRejectedConfirmation(
  upstream: string,
  branch: string,
  count: number,
  canPull: boolean,
  canForce: boolean,
): Confirmation<'pull' | 'force'> {
  return {
    message: `'${upstream}' has ${plural(count, 'commit')} that '${branch}' doesn't have.`,
    detail: 'Pull them first, or overwrite them with a force push.',
    buttons: [
      ...(canPull ? [{ id: 'pull' as const, label: 'Pull' }] : []),
      ...(canForce ? [{ id: 'force' as const, label: 'Force Push (With Lease)...' }] : []),
    ],
  };
}

export function forcePushConfirmation(
  branch: string,
  remote: string,
  upstream: string,
  count: number,
  newest: string | undefined,
): Confirmation<'force'> {
  return {
    message: `Force push '${branch}' to '${remote}'?`,
    detail: `Replaces ${upstream}, which has ${plural(count, 'commit')} '${branch}' doesn't have${newest === undefined ? '' : ` (newest "${newest}")`}. The push fails if ${upstream} changed since Strata read it.`,
    buttons: [{ id: 'force', label: 'Force Push' }],
  };
}

export const publishPick = (branch: string): string => `Publish '${branch}' to…`;

export const REMOTE_DONE = {
  fetched: (remote: string | undefined): string => `Fetched ${remote ?? 'all remotes'}`,
  published: (branch: string, remote: string): string => `Published '${branch}' to ${remote}`,
  pushed: (branch: string, upstream: string): string => `Pushed '${branch}' to ${upstream}`,
  forcePushed: (branch: string, upstream: string): string => `Force pushed '${branch}' to ${upstream}`,
  upToDate: 'Already up to date',
};

export const REMOTE_DOING = {
  fetching: (remote: string | undefined): string => `Fetching ${remote ?? 'all remotes'}`,
  pushing: (branch: string, dest: string): string => `Pushing '${branch}' to ${dest}`,
  publishing: (branch: string, remote: string): string => `Publishing '${branch}' to ${remote}`,
};

/** Why a diverged pull offers less than Rebase and Merge, or rebases differently than configured. */
export const PULL_NOTES = {
  ffOnly: 'pull.ff is "only", so git would not merge.',
  rebaseMerges:
    'pull.rebase is "merges"; Strata\'s rebase replays the merged commits one by one instead of keeping the merges.',
};

/** The two picks behind Branch and Tag Actions...: which ref, then which of its menu's commands. */
export const REF_ACTIONS = {
  title: 'Branch and Tag Actions',
  kind: { branch: 'branch', remote: 'remote branch', tag: 'tag' } as Record<RefKind, string>,
  actionsFor: (name: string): string => `Actions for '${name}'`,
};
