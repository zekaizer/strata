export interface Commit {
  hash: string;
  /** First parent first. Empty for root commits. */
  parents: string[];
  author: string;
  authorEmail: string;
  /** Unix seconds. */
  authorTime: number;
  /** Unix seconds. */
  commitTime: number;
  subject: string;
}
