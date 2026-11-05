/** Size of a unified diff as git's --shortstat counts it. */
export interface PatchStats {
  files: number;
  insertions: number;
  deletions: number;
}

/** Counts the files and changed lines of a patch (plain diff or mbox email). */
export function patchStats(patch: string): PatchStats {
  const stats = { files: 0, insertions: 0, deletions: 0 };
  // Only lines inside a hunk are changes: '---'/'+++' file headers and the email body come before one.
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      stats.files++;
      inHunk = false;
    } else if (line.startsWith('@@')) inHunk = stats.files > 0;
    else if (inHunk && line.startsWith('+')) stats.insertions++;
    else if (inHunk && line.startsWith('-')) stats.deletions++;
    else if (inHunk && !line.startsWith(' ') && !line.startsWith('\\')) inHunk = false;
  }
  return stats;
}
