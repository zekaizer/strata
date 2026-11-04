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
  /** Parent the file list is relative to; undefined for a root commit (compared with the empty tree). */
  base: string | undefined;
  files: FileChange[];
}
