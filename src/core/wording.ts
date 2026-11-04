import type { DirtyFacts, StashChoice, StashChoices, StashOp } from './autostash.ts';
import type { ResetMode } from './operations.ts';
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
const OP_TITLE: Record<OperationKind, string> = {
  rebase: 'Rebase',
  merge: 'Merge',
  cherryPick: 'Cherry Pick',
  revert: 'Revert',
};

/** The closing section of every confirmation that finds uncommitted changes. */
export function dirtySection(dirty: DirtyFacts, choices: StashChoices, submodules: number): string {
  const staged = dirty.staged > 0 ? ` (${dirty.staged} staged)` : '';
  return [
    `Uncommitted changes: ${plural(dirty.files, 'file')}${staged}.`,
    choices.explain,
    'Untracked files are not stashed; they stay in place.',
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
      ? `Their changes and your uncommitted changes in ${plural(n, 'file')} are discarded.`
      : 'Their changes are discarded.',
};

/** Asks only when commits leave the branch or work is discarded. */
export function resetConfirmation(f: ResetFacts, mode: ResetMode): Confirmation<'reset'> | undefined {
  if (f.dropped.length === 0 && !(mode === 'hard' && f.dirtyFiles > 0)) return undefined;
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

export function abortConfirmation(
  op: OperationKind,
  branch: string | undefined,
  back: string,
  autostash: boolean,
): Confirmation<'abort'> {
  const name = branch === undefined ? 'HEAD' : `'${branch}'`;
  return {
    message: `Abort the ${OP_NAME[op]}?`,
    detail: [
      `${name} goes back to ${back} as before the ${OP_NAME[op]}.`,
      "Conflict resolutions you've made are discarded.",
      ...(autostash ? ['Your stashed changes are restored.'] : []),
    ].join(' '),
    buttons: [{ id: 'abort', label: `Abort ${OP_TITLE[op]}` }],
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
    detail: `It points at ${at.short} "${at.subject}". Tags already pushed stay on remotes.`,
    buttons: [{ id: 'delete', label: 'Delete Tag' }],
  };
}

export const checkedOutElsewhere = (branch: string, path: string | undefined): string =>
  `'${branch}' is checked out in another worktree${path === undefined ? '' : ` (${path})`}.`;

/** `done`: what the operation did; `paths`: the first of `count` conflicted files. */
export const popConflicted = (done: string, paths: readonly string[], count: number): string =>
  `${done}, but restoring your stashed changes conflicted in ${plural(count, 'file')} (${fileList(paths)}). Your changes are safe in stash@{0}.`;

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

/** Run in Terminal could not quote the command for the terminal's shell. */
export const commandCopied = (line: string): string =>
  `Strata can't quote this command safely for your terminal's shell, so it copied it instead: ${line}`;
