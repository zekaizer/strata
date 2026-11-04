import type { CommitDetails, FileChange, FileStatus } from '../core/details.ts';
import { runGit } from './run.ts';

const HASH = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const STATUSES: readonly string[] = ['A', 'M', 'D', 'R', 'C', 'T'] satisfies FileStatus[];
const isStatus = (s: string): s is FileStatus => STATUSES.includes(s);

/**
 * Reads the full message and the files changed in `hash` relative to `base`
 * (default: first parent; the empty tree for a root commit).
 */
export async function readCommitDetails(git: string, cwd: string, hash: string, base?: string): Promise<CommitDetails> {
  // Callers pass ids that came from the webview; never let them reach git as options.
  for (const h of [hash, base]) if (h !== undefined && !HASH.test(h)) throw new Error(`invalid commit id: ${h}`);
  const format = ['%H', '%P', '%aN', '%aE', '%at', '%cN', '%cE', '%ct', '%B'].join('%x00');
  const meta = await runGit(git, cwd, [
    'show',
    '-s',
    '--no-color',
    '--encoding=UTF-8',
    `--format=${format}`,
    hash,
    '--',
  ]);
  const [h, parents, author, authorEmail, at, committer, committerEmail, ct, message] = meta.split('\0') as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const parentList = parents ? parents.split(' ') : [];
  const from = base ?? parentList[0];
  const diff = await runGit(git, cwd, [
    'diff-tree',
    '-z',
    '-r',
    '-M',
    '--no-commit-id',
    '--name-status',
    ...(from === undefined ? ['--root', hash] : [from, hash]),
    '--',
  ]);
  return {
    hash: h,
    parents: parentList,
    author,
    authorEmail,
    authorTime: Number(at),
    committer,
    committerEmail,
    commitTime: Number(ct),
    message: message.replace(/\n+$/, ''),
    base: from,
    files: parseNameStatus(diff),
  };
}

/** Parses `git diff-tree -z --name-status`: status NUL path NUL, with two paths for renames and copies. */
function parseNameStatus(out: string): FileChange[] {
  const t = out.split('\0');
  const files: FileChange[] = [];
  for (let i = 0; i + 1 < t.length;) {
    const code = t[i]!;
    const status = code[0] ?? '';
    if (!isStatus(status)) throw new Error(`unexpected diff-tree status ${JSON.stringify(code)}`);
    if (status === 'R' || status === 'C') {
      files.push({ status, oldPath: t[i + 1]!, path: t[i + 2]! });
      i += 3;
    } else {
      files.push({ status, path: t[i + 1]! });
      i += 2;
    }
  }
  return files;
}
