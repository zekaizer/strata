import type { CommitRef, ResetFacts } from '../core/wording.ts';
import { runGit } from './run.ts';

/** A commit as flows name it. */
export interface CommitInfo extends CommitRef {
  hash: string;
}

/** Commits listed by name in a confirmation; counts are exact either way. */
export const COMMITS_LISTED = 50;

const optional = (p: Promise<string>) =>
  p.then(
    (s) => s.trim() || undefined,
    () => undefined,
  );

async function commits(git: string, cwd: string, revs: string[]): Promise<CommitRef[]> {
  const out = await runGit(git, cwd, [
    'log',
    '-z',
    '--no-color',
    '--encoding=UTF-8',
    `--max-count=${COMMITS_LISTED}`,
    '--format=%h%x00%s',
    ...revs,
    '--',
  ]);
  const f = out.split('\0');
  const list: CommitRef[] = [];
  for (let i = 0; i + 1 < f.length; i += 2) list.push({ short: f[i]!.replace(/^\n/, ''), subject: f[i + 1]! });
  return list;
}

const count = async (git: string, cwd: string, revs: string[]) =>
  Number((await runGit(git, cwd, ['rev-list', '--count', ...revs, '--'])).trim());

/**
 * Every ref except the branch `except`: what still reaches a commit once that branch moves or goes.
 * --exclude takes the name without refs/heads/ and applies to the --branches right after it only.
 */
const otherRefs = (except: string | undefined) => [
  ...(except === undefined ? [] : [`--exclude=${except}`]),
  '--branches',
  '--remotes',
  '--tags',
];

/** What resetting HEAD (and its branch) to `target` would do. */
export async function readResetFacts(
  git: string,
  cwd: string,
  target: string,
  dirtyFiles: number,
): Promise<ResetFacts> {
  const [branch, upstream] = await Promise.all([
    optional(runGit(git, cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])),
    optional(runGit(git, cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])),
  ]);
  const range = [`${target}..HEAD`];
  const [[tip], dropped, gained, notOnUpstream, total, unreachable] = await Promise.all([
    commits(git, cwd, ['--no-walk', target]),
    commits(git, cwd, range),
    count(git, cwd, [`HEAD..${target}`]),
    upstream === undefined ? Promise.resolve(0) : count(git, cwd, [...range, '--not', upstream]),
    count(git, cwd, range),
    count(git, cwd, [...range, '--not', ...otherRefs(branch)]),
  ]);
  return {
    branch,
    target: tip!,
    dropped,
    gained,
    onUpstream: upstream === undefined ? 0 : total - notOnUpstream,
    unreachable,
    upstream,
    dirtyFiles,
  };
}

/** Commits of `branch` on no other branch, remote-tracking branch or tag, newest first. */
export function readUnmergedCommits(git: string, cwd: string, branch: string): Promise<CommitRef[]> {
  return commits(git, cwd, [`refs/heads/${branch}`, '--not', ...otherRefs(branch)]);
}

/** Of `dirty` paths, those that also differ between HEAD and `target` (a switch would have to touch them). */
export async function readOverlap(
  git: string,
  cwd: string,
  target: string,
  dirty: readonly string[],
): Promise<string[]> {
  if (dirty.length === 0) return [];
  const changed = new Set(
    (await runGit(git, cwd, ['diff', '--name-only', '-z', '--no-renames', 'HEAD', target, '--'])).split('\0'),
  );
  return dirty.filter((p) => changed.has(p));
}

export async function readCommit(git: string, cwd: string, rev: string): Promise<CommitInfo> {
  const out = await runGit(git, cwd, [
    'log',
    '-1',
    '--no-walk',
    '-z',
    '--format=%H%x00%h%x00%s',
    '--end-of-options',
    rev,
    '--',
  ]);
  const [hash = '', short = '', subject = ''] = out.split('\0');
  return { hash, short, subject };
}
