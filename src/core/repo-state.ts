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
  /** Unmerged paths, at most CONFLICTS_SHOWN of them. */
  conflicts: string[];
  conflictCount: number;
  /** git holds an autostash it re-applies when the operation finishes or is aborted. */
  autostash: boolean;
}

export const CONFLICTS_SHOWN = 50;

/** Uncommitted changes to tracked files (untracked files are not counted: autostash leaves them alone). */
export interface Worktree {
  /** Paths with staged or unstaged changes, conflicts included. */
  paths: string[];
  /** Of `paths`, those deleted from the index (`git rm`): no file is left there for a path to match. */
  deleted: string[];
  staged: number;
  unstaged: number;
  /** Submodules with changes inside them, which git stash never records. */
  submodules: number;
}

/** Parses `git status --porcelain=v2 -z --untracked-files=no`. */
export function parseStatus(out: string): Worktree {
  const w: Worktree = { paths: [], deleted: [], staged: 0, unstaged: 0, submodules: 0 };
  const records = out.split('\0');
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    // Fields before the path: ordinary 8, renamed/copied 9 (its original path is the next record), unmerged 10.
    const fields = { '1': 8, '2': 9, u: 10 }[r[0] ?? ''];
    if (fields === undefined) continue;
    const parts = r.split(' ');
    const [, xy = '..', sub = 'N...'] = parts;
    const path = parts.slice(fields).join(' ');
    w.paths.push(path);
    if (r[0] === '1' && xy[0] === 'D') w.deleted.push(path);
    if (r[0] === '2') i++;
    if (r[0] !== 'u' && xy[0] !== '.') w.staged++;
    if (r[0] === 'u' || xy[1] !== '.') w.unstaged++;
    if (sub[0] === 'S' && (sub[2] === 'M' || sub[3] === 'U')) w.submodules++;
  }
  return w;
}

/** A stash by its commit (stable) and its current stash@{n} number. */
export interface StashRef {
  hash: string;
  index: number;
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
