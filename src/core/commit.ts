export interface Commit {
  hash: string;
  /** First parent first. Empty for root commits. */
  parents: string[];
  /** In first-parent history: a merge's other parents, which `parents` leaves out. */
  otherParents?: string[];
  author: string;
  authorEmail: string;
  /** Unix seconds. */
  authorTime: number;
  /** Unix seconds. */
  commitTime: number;
  subject: string;
}
