export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T';

export interface FileChange {
  status: FileStatus;
  path: string;
  /** Source path of a rename or copy. */
  oldPath?: string;
}

export interface CommitDetails {
  hash: string;
  parents: string[];
  author: string;
  authorEmail: string;
  authorTime: number;
  committer: string;
  committerEmail: string;
  commitTime: number;
  /** Full message: subject, blank line, body. */
  message: string;
  /** Subject of each parent, in `parents` order. */
  parentSubjects: string[];
  /** Parent the file list is relative to; undefined for a root commit (compared with the empty tree). */
  base: string | undefined;
  files: FileChange[];
  /** Set for a stash commit, whose files are its changes to the base. */
  stash?: StashDetails;
}

/** What a stash holds besides its changes: which of them are staged, and its untracked files. */
export interface StashDetails {
  /** Paths whose staged content differs from the base. */
  staged: string[];
  /** The commit holding the untracked files, which are all added in it. */
  untracked: { hash: string; files: FileChange[] } | undefined;
}

/** How a changed file can be opened. */
export type FileView = 'diff' | 'before' | 'after';

/**
 * Views that exist for a change: an added file has no "before" and nothing
 * to diff against, a deleted file has no "after". `base` is undefined for a
 * root commit, whose files are all added.
 */
export function fileViews(file: FileChange, base: string | undefined): FileView[] {
  if (file.status === 'A' || base === undefined) return ['after'];
  if (file.status === 'D') return ['before'];
  return ['diff', 'before', 'after'];
}

/**
 * The line above the changed files: what was compared with what. `base` is the commit the files
 * are relative to; `baseLabel` says which parent it is when that is not obvious (merges).
 */
export function filesSummary(d: CommitDetails): {
  text: string;
  base: string | undefined;
  baseLabel: '' | 'first parent';
  root: boolean;
} {
  const n = d.files.length;
  const files = `${n} file${n === 1 ? '' : 's'}`;
  if (d.base === undefined) return { text: `${files} added`, base: undefined, baseLabel: '', root: true };
  const first = d.parents.length > 1 && d.base === d.parents[0];
  return { text: `${files} changed`, base: d.base, baseLabel: first ? 'first parent' : '', root: false };
}
