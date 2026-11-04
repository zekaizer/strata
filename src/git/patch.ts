import type { FileChange } from '../core/details.ts';
import { isCommitId } from './details.ts';
import { runGit } from './run.ts';

/**
 * Overrides user configuration that would produce a patch `git apply` or `git am` rejects
 * (diff.noprefix, diff.mnemonicPrefix, diff.relative, external diff, textconv, color).
 */
const DIFF_FLAGS = [
  '--binary',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-relative',
  '--src-prefix=a/',
  '--dst-prefix=b/',
];

function checkIds(...ids: (string | undefined)[]): void {
  // Ids come from the webview; never let one reach git as an option.
  for (const id of ids) if (id !== undefined && !isCommitId(id)) throw new Error(`invalid commit id: ${id}`);
}

/**
 * The commit as an mbox email patch, so `git am` re-creates it with its author and message.
 * A merge is diffed against its first parent: `format-patch -1` would print some other,
 * non-merge commit instead.
 */
export async function readCommitPatch(git: string, cwd: string, hash: string): Promise<string> {
  checkIds(hash);
  return runGit(git, cwd, [
    '-c',
    'log.showSignature=false',
    '-c',
    'log.mailmap=false',
    'show',
    '--format=email',
    '--encoding=UTF-8',
    '--no-notes',
    '--stat',
    '--patch',
    '-m',
    '--first-parent',
    ...DIFF_FLAGS,
    hash,
    '--',
  ]);
}

/** The change to one file between `base` (the empty tree when undefined) and `hash`, as a plain diff. */
export async function readFilePatch(
  git: string,
  cwd: string,
  hash: string,
  base: string | undefined,
  file: FileChange,
): Promise<string> {
  checkIds(hash, base);
  // Both paths of a rename, so -M pairs them instead of printing a deletion and an addition.
  const paths = file.oldPath === undefined ? [file.path] : [file.oldPath, file.path];
  return runGit(git, cwd, [
    'diff-tree',
    '--patch',
    '-M',
    ...DIFF_FLAGS,
    ...(base === undefined ? ['--root', hash] : [base, hash]),
    '--',
    ...paths.map((p) => `:(literal)${p}`),
  ]);
}

/**
 * A stash as one plain diff: its tracked changes against the commit it was made on, then its
 * untracked files (the third parent, a root commit) as added files.
 */
export async function readStashPatch(git: string, cwd: string, hash: string): Promise<string> {
  checkIds(hash);
  const [base = '', , untracked] = (await runGit(git, cwd, ['rev-parse', `${hash}^@`])).trim().split('\n');
  const tracked = await runGit(git, cwd, ['diff-tree', '--patch', '-r', ...DIFF_FLAGS, base, hash, '--']);
  if (untracked === undefined) return tracked;
  return (
    tracked +
    (await runGit(git, cwd, ['diff-tree', '--patch', '-r', '--root', '--no-commit-id', ...DIFF_FLAGS, untracked, '--']))
  );
}
