/** What went wrong in a git command, as far as its stderr tells. */
export type GitErrorKind =
  | 'auth'
  | 'hostKey'
  | 'lock'
  | 'rejected'
  /** A hook or the server refused the push; forcing cannot help. */
  | 'remoteRejected'
  /** A tag push refused because the remote has a different tag of that name. */
  | 'tagExists'
  /** No common commit, e.g. in a shallow clone. */
  | 'unrelated'
  | 'conflict'
  | 'localChanges'
  | 'untrackedOverwrite'
  | 'checkedOutElsewhere'
  | 'notMerged'
  | 'noUpstream'
  /** A fetch of a ref the remote does not have. */
  | 'noRemoteRef'
  | 'other';

/** Classifies a failed git command by its stderr; the command must run with English messages (see runGitOp). */
export function classifyGitError(stderr: string): GitErrorKind {
  return PATTERNS.find(([pattern]) => pattern.test(stderr))?.[1] ?? 'other';
}

/** git's heading above the untracked files (or directories holding them) an operation would overwrite. */
const IN_THE_WAY =
  /untracked working tree files would be (?:overwritten|removed) by|directories would lose untracked files in them/;

/** First match wins: a conflict message can also mention local changes, an auth failure the remote. */
const PATTERNS: readonly [RegExp, GitErrorKind][] = [
  [
    /terminal prompts disabled|could not read (Username|Password)|Authentication failed|Permission denied \(publickey/,
    'auth',
  ],
  [/Host key verification failed/, 'hostKey'],
  [/index\.lock|Another git process seems to be running/, 'lock'],
  [/^CONFLICT \(|could not apply|Automatic merge failed|after resolving the conflicts/m, 'conflict'],
  // Before untrackedOverwrite: moving the untracked files out of the way alone would not help.
  [
    /local changes to the following files would be overwritten|You have unstaged changes|Your index contains uncommitted changes|commit or stash them/,
    'localChanges',
  ],
  [IN_THE_WAY, 'untrackedOverwrite'],
  [/is already checked out at|is already used by worktree at|used by worktree at/, 'checkedOutElsewhere'],
  [/\[remote rejected\]/, 'remoteRejected'],
  [/\[rejected\][^\n]*\(already exists\)/, 'tagExists'],
  [/\[rejected\]|Updates were rejected/, 'rejected'],
  [/refusing to merge unrelated histories/, 'unrelated'],
  [/is not fully merged/, 'notMerged'],
  [/has no upstream branch|no tracking information/, 'noUpstream'],
  [/couldn't find remote ref/, 'noRemoteRef'],
];

/** The last progress line of a chunk of `--progress` stderr, e.g. "Receiving objects:  45% (450/1000)". */
export function parseProgress(chunk: string): { phase: string; percent: number } | undefined {
  let last: { phase: string; percent: number } | undefined;
  for (const m of chunk.matchAll(/(?:^|[\r\n])(?:remote: )?([A-Za-z][A-Za-z ]*?):\s+(\d{1,3})%/g))
    last = { phase: m[1]!, percent: Number(m[2]) };
  return last;
}

/**
 * The paths an untrackedOverwrite error lists: files, and directories whose untracked files would
 * be lost. git prints each on its own tab-indented line under the heading, unquoted (a name with a
 * newline in it splits, and then names no file).
 */
export function untrackedInTheWay(stderr: string): string[] {
  const paths: string[] = [];
  let listing = false;
  for (const line of stderr.split('\n')) {
    if (listing && line.startsWith('\t')) paths.push(line.slice(1));
    else listing = IN_THE_WAY.test(line);
  }
  return paths;
}

/** The untracked files of a stash that git did not restore because they exist ("<path> already exists, no checkout"). */
export const untrackedNotRestored = (stderr: string): string[] =>
  stderr.split('\n').flatMap((line) => /^(.+) already exists, no checkout$/.exec(line)?.slice(1) ?? []);

/** The worktree a checkedOutElsewhere error names. */
export const checkedOutPath = (stderr: string): string | undefined =>
  /(?:checked out|used by worktree) at '([^']+)'/.exec(stderr)?.[1];
