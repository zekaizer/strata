import type { FileChange, FileStatus } from './details.ts';

/** Operations git can stop in the middle of, waiting for the user (conflicts, or `edit` in a rebase). */
export type OperationKind = 'rebase' | 'merge' | 'cherryPick' | 'revert';

/** An operation in progress in the worktree, started by Strata or anywhere else. */
export interface OperationState {
  kind: OperationKind;
  /** Branch being rebased (rebase), or the branch HEAD is on; undefined when detached. */
  branch: string | undefined;
  /** Rebase: the commit being rebased onto. */
  onto: string | undefined;
  /** Rebase: which of how many commits it stopped at (1-based). */
  step: { current: number; total: number } | undefined;
  /** The commit being applied: the rebase stop, or CHERRY_PICK_HEAD / REVERT_HEAD / MERGE_HEAD. */
  applying: string | undefined;
  /**
   * A cherry pick or revert of several commits stopped between them (the stopped commit was
   * committed or reset outside it, leaving no CHERRY_PICK_HEAD or REVERT_HEAD): how many commits
   * Continue still applies. Skip has nothing to skip there.
   */
  remaining?: number;
  /** Unmerged paths, at most CONFLICTS_SHOWN of them. */
  conflicts: string[];
  conflictCount: number;
  /** Cherry pick or revert with nothing staged beyond HEAD: git refuses to continue, only skip or abort. */
  empty: boolean;
  /** git holds an autostash it re-applies when the operation finishes or is aborted. */
  autostash: boolean;
}

export const CONFLICTS_SHOWN = 50;

/** Whether `text` still has git's conflict markers, or is binary (git writes no markers into it). */
export const hasConflictMarkers = (text: string): boolean => text.includes('\0') || /^(?:<{7}|>{7})(?: |$)/m.test(text);

/** Uncommitted changes. `paths` and the counts other than `untracked` cover tracked files only: autostash leaves untracked files alone. */
export interface WorkingChanges {
  /** Paths with staged or unstaged changes, conflicts included. */
  paths: string[];
  /** Of `paths`, those deleted from the index (`git rm`): no file is left there for a path to match. */
  deleted: string[];
  staged: number;
  /** Paths changed between the index and the work tree, conflicted ones not included. */
  unstaged: number;
  /** Submodules with changes inside them, which git stash never records. */
  submodules: number;
  /** Unmerged paths. */
  conflicted: number;
  /** Untracked files; undefined when git was told not to look for them. */
  untracked: number | undefined;
}

/** What the uncommitted changes row shows. */
export type ChangesSummary = Pick<WorkingChanges, 'staged' | 'unstaged' | 'conflicted' | 'untracked' | 'submodules'>;

/** One record of `git status --porcelain=v2 -z`. */
type StatusRecord =
  /** Ordinary ('1') or renamed/copied ('2'): XY are the index and work tree states, '.' for unchanged. */
  | { kind: 'changed'; xy: string; sub: string; path: string; oldPath: string | undefined }
  | { kind: 'unmerged'; path: string }
  | { kind: 'untracked'; path: string };

function* statusRecords(out: string): Generator<StatusRecord> {
  const records = out.split('\0');
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    if (r.startsWith('? ')) {
      yield { kind: 'untracked', path: r.slice(2) };
      continue;
    }
    // Fields before the path: ordinary 8, renamed/copied 9 (its original path is the next record), unmerged 10.
    const fields = { '1': 8, '2': 9, u: 10 }[r[0] ?? ''];
    if (fields === undefined) continue;
    const parts = r.split(' ');
    const path = parts.slice(fields).join(' ');
    if (r[0] === 'u') yield { kind: 'unmerged', path };
    else
      yield {
        kind: 'changed',
        xy: parts[1] ?? '..',
        sub: parts[2] ?? 'N...',
        path,
        oldPath: r[0] === '2' ? records[++i] : undefined,
      };
  }
}

/** What the uncommitted changes row shows; undefined when there is nothing to show. */
export function changesSummary(w: WorkingChanges): ChangesSummary | undefined {
  const { staged, unstaged, conflicted, untracked, submodules } = w;
  if (staged + unstaged + conflicted + (untracked ?? 0) === 0) return undefined;
  return { staged, unstaged, conflicted, untracked, submodules };
}

export interface ChangeCount {
  kind: 'conflicted' | 'staged' | 'unstaged' | 'untracked';
  n: number;
  /** "4 conflicts", "2 staged", "3 changed", "1 untracked". */
  text: string;
}

/** The counts the uncommitted changes row shows, conflicts first, none of them zero. */
export function changeCounts(s: ChangesSummary): ChangeCount[] {
  const counts: ChangeCount[] = [
    { kind: 'conflicted', n: s.conflicted, text: `${s.conflicted} ${s.conflicted === 1 ? 'conflict' : 'conflicts'}` },
    { kind: 'staged', n: s.staged, text: `${s.staged} staged` },
    { kind: 'unstaged', n: s.unstaged, text: `${s.unstaged} changed` },
    { kind: 'untracked', n: s.untracked ?? 0, text: `${s.untracked ?? 0} untracked` },
  ];
  return counts.filter((c) => c.n > 0);
}

/** What the uncommitted changes row says to a tooltip and a screen reader. */
export function describeChanges(s: ChangesSummary, branch: string | undefined): string {
  const on = branch === undefined ? '' : ` on ${branch}`;
  const notes = [
    s.untracked === undefined ? 'Untracked files are not counted.' : '',
    s.submodules > 0 ? 'git stash never records changes inside submodules.' : '',
  ];
  return [
    `Uncommitted changes${on}: ${changeCounts(s)
      .map((c) => c.text)
      .join(', ')}.`,
    ...notes,
  ]
    .filter((t) => t)
    .join(' ');
}

/** Parses `git status --porcelain=v2 -z`; `untracked`: whether git was asked to list untracked files. */
export function parseStatus(out: string, untracked = false): WorkingChanges {
  const w: WorkingChanges = {
    paths: [],
    deleted: [],
    staged: 0,
    unstaged: 0,
    submodules: 0,
    conflicted: 0,
    untracked: untracked ? 0 : undefined,
  };
  for (const r of statusRecords(out)) {
    if (r.kind === 'untracked') {
      if (w.untracked !== undefined) w.untracked++;
      continue;
    }
    w.paths.push(r.path);
    if (r.kind === 'unmerged') {
      w.conflicted++;
      continue;
    }
    if (r.xy[0] === 'D' && r.oldPath === undefined) w.deleted.push(r.path);
    if (r.xy[0] !== '.') w.staged++;
    if (r.xy[1] !== '.') w.unstaged++;
    if (r.sub[0] === 'S' && (r.sub[2] === 'M' || r.sub[3] === 'U')) w.submodules++;
  }
  return w;
}

export type ChangeGroup = 'staged' | 'unstaged' | 'conflicted' | 'untracked';

/** A path as the uncommitted changes row lists it; a path both staged and changed again is in two groups. */
export interface ChangedPath extends FileChange {
  group: ChangeGroup;
}

const STATUSES: ReadonlySet<string> = new Set<FileStatus>(['A', 'M', 'D', 'R', 'C', 'T']);
const fileStatus = (c: string | undefined): FileStatus => (STATUSES.has(c ?? '') ? (c as FileStatus) : 'M');

/**
 * The changed paths of `git status --porcelain=v2 -z`, at most `limit` per group; `truncated`: how
 * many more. A conflicted path is 'M' and an untracked one 'A' (as committing it would add it).
 */
export function listChanges(out: string, limit: number): { files: ChangedPath[]; truncated: number } {
  const files: ChangedPath[] = [];
  const counts: Record<ChangeGroup, number> = { staged: 0, unstaged: 0, conflicted: 0, untracked: 0 };
  let truncated = 0;
  const add = (group: ChangeGroup, status: FileStatus, path: string, oldPath?: string) => {
    if (counts[group]++ >= limit) truncated++;
    else files.push({ group, status, path, ...(oldPath === undefined ? {} : { oldPath }) });
  };
  for (const r of statusRecords(out)) {
    if (r.kind === 'untracked') add('untracked', 'A', r.path);
    else if (r.kind === 'unmerged') add('conflicted', 'M', r.path);
    else {
      if (r.xy[0] !== '.') add('staged', fileStatus(r.xy[0]), r.path, r.oldPath);
      // The work tree side of a rename is a change to the new path.
      if (r.xy[1] !== '.') add('unstaged', fileStatus(r.xy[1]), r.path);
    }
  }
  return { files, truncated };
}

/** A stash by its commit (stable) and its current stash@{n} number. */
export interface StashRef {
  hash: string;
  /** The reflog subject, e.g. "On main: Add lexer" or "autostash". */
  message: string;
}

/**
 * Something left in the worktree with no operation in progress, shown in the graph's banner until
 * the user settles it.
 */
export type Leftover =
  /** Strata saw restoring a stash conflict; git kept the stash. `files` empty: the conflicts are resolved. */
  | { kind: 'restoreConflicted'; stash: StashRef; files: string[] }
  /** Strata stashed changes before an operation that finished or stopped elsewhere, and has not restored them. */
  | { kind: 'pendingStash'; stash: StashRef; operation: string }
  /** Unmerged files nobody is resolving (e.g. a `stash pop` in a terminal); `autostash`: an entry git kept. */
  | { kind: 'unmerged'; files: string[]; count: number; autostash: StashRef | undefined };
