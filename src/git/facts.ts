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

export const countCommits = count;

/** Whether `a` is an ancestor of (or equal to) `b`. */
export const isAncestor = (git: string, cwd: string, a: string, b: string): Promise<boolean> =>
  runGit(git, cwd, ['merge-base', '--is-ancestor', a, b]).then(
    () => true,
    // Exit status 1: not an ancestor.
    () => false,
  );

/** A boolean git config value as git reads it ("yes", "on", "1"...); undefined when unset. */
export const readConfigBool = (git: string, cwd: string, key: string): Promise<boolean | undefined> =>
  optional(runGit(git, cwd, ['config', '--type=bool', '--get', key])).then((v) =>
    v === undefined ? undefined : v === 'true',
  );

/** Paths with unresolved conflicts. */
export const readUnmerged = async (git: string, cwd: string): Promise<string[]> =>
  (await runGit(git, cwd, ['diff', '--name-only', '-z', '--diff-filter=U', '--'])).split('\0').filter((p) => p !== '');

/** n in stash@{n} of the stash commit `hash` now; undefined once it is gone. */
export async function readStashIndex(git: string, cwd: string, hash: string): Promise<number | undefined> {
  const out = await optional(runGit(git, cwd, ['log', '--walk-reflogs', '--format=%H', 'refs/stash', '--']));
  const index = (out ?? '').split('\n').indexOf(hash);
  return index < 0 ? undefined : index;
}

/** The stash commit of stash@{0}. */
export const readStashTop = (git: string, cwd: string): Promise<string | undefined> =>
  optional(runGit(git, cwd, ['rev-parse', '--quiet', '--verify', 'refs/stash']));

/** A branch's upstream: "origin/main", its remote and the branch on that remote. */
export async function readUpstream(
  git: string,
  cwd: string,
  branch: string,
): Promise<{ name: string; remote: string; remoteBranch: string } | undefined> {
  const out = await runGit(git, cwd, [
    'for-each-ref',
    '--format=%(upstream:short)%00%(upstream:remotename)%00%(upstream:remoteref)',
    `refs/heads/${branch}`,
  ]);
  const [name = '', remote = '', remoteRef = ''] = out.trim().split('\0');
  if (name === '' || remote === '' || !remoteRef.startsWith('refs/heads/')) return undefined;
  return { name, remote, remoteBranch: remoteRef.slice('refs/heads/'.length) };
}

/** The branch HEAD is on (undefined when detached) and its commit. */
export async function readHead(git: string, cwd: string): Promise<{ branch: string | undefined; hash: string }> {
  const [branch, hash] = await Promise.all([
    optional(runGit(git, cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])),
    runGit(git, cwd, ['rev-parse', '--verify', 'HEAD']),
  ]);
  return { branch, hash: hash.trim() };
}

/** The best common ancestor of two commits; undefined for unrelated histories. */
export const readMergeBase = (git: string, cwd: string, a: string, b: string): Promise<string | undefined> =>
  optional(runGit(git, cwd, ['merge-base', a, b]));
