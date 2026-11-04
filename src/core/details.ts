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
 * The line above the changed files. `base` is set when the comparison is not
 * the obvious one (the only parent): for merges and explicit bases.
 */
export function filesSummary(d: CommitDetails): { text: string; base: string | undefined } {
  const text = `${d.files.length} file${d.files.length === 1 ? '' : 's'} changed`;
  if (d.base === undefined || (d.parents.length === 1 && d.base === d.parents[0])) return { text, base: undefined };
  return {
    text: d.parents.length > 1 && d.base === d.parents[0] ? `${text} vs first parent` : `${text} vs`,
    base: d.base,
  };
}
