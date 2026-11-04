import type { CommitRef, ResetFacts } from '../core/wording.ts';
import { runGit } from './run.ts';
import { readStashList } from './stash.ts';

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

/** The stash commit `hash` now: n in stash@{n} and its reflog subject; undefined once it is gone. */
export async function readStash(
  git: string,
  cwd: string,
  hash: string,
): Promise<{ hash: string; index: number; message: string } | undefined> {
  const s = (await readStashList(git, cwd)).find((e) => e.hash === hash);
  return s && { hash, index: s.index, message: s.message };
}

/** The stash commit of stash@{0}. */
export const readStashTop = (git: string, cwd: string): Promise<string | undefined> =>
  optional(runGit(git, cwd, ['rev-parse', '--quiet', '--verify', 'refs/stash']));

/**
 * A branch's upstream: its ref (refs/remotes/origin/main, or refs/heads/main for a local branch,
 * whose remote is "."), its short name as git prints it, its remote and the branch on that remote.
 */
export async function readUpstream(
  git: string,
  cwd: string,
  branch: string,
): Promise<{ ref: string; name: string; remote: string; remoteBranch: string } | undefined> {
  const out = await runGit(git, cwd, [
    'for-each-ref',
    '--format=%(upstream)%00%(upstream:short)%00%(upstream:remotename)%00%(upstream:remoteref)',
    `refs/heads/${branch}`,
  ]);
  const [ref = '', name = '', remote = '', remoteRef = ''] = out.trim().split('\0');
  if (ref === '' || remote === '' || !remoteRef.startsWith('refs/heads/')) return undefined;
  return { ref, name, remote, remoteBranch: remoteRef.slice('refs/heads/'.length) };
}

/** The branch HEAD is on (undefined when detached) and its commit. */
export async function readHead(git: string, cwd: string): Promise<{ branch: string | undefined; hash: string }> {
  const [branch, hash] = await Promise.all([
    optional(runGit(git, cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])),
    runGit(git, cwd, ['rev-parse', '--verify', 'HEAD']),
  ]);
  return { branch, hash: hash.trim() };
}

/**
 * Where HEAD forked from `upstream` by upstream's reflog, which also knows the commits upstream
 * had before it was rewritten (what `git pull --rebase` replays after); undefined when unknown.
 */
export const readForkPoint = (git: string, cwd: string, upstream: string): Promise<string | undefined> =>
  optional(runGit(git, cwd, ['merge-base', '--fork-point', upstream, 'HEAD']));

/** The best common ancestor of two commits; undefined for unrelated histories. */
export const readMergeBase = (git: string, cwd: string, a: string, b: string): Promise<string | undefined> =>
  optional(runGit(git, cwd, ['merge-base', a, b]));

/** Every `branch.<branch>.*` config entry, in order (multi-valued keys repeat). */
export async function readBranchConfig(git: string, cwd: string, branch: string): Promise<[string, string][]> {
  const out = (await optional(runGit(git, cwd, ['config', '-z', '--get-regexp', '^branch\\.']))) ?? '';
  const prefix = `branch.${branch}.`;
  return out
    .split('\0')
    .map((entry): [string, string] => {
      const nl = entry.indexOf('\n');
      return nl < 0 ? [entry, ''] : [entry.slice(0, nl), entry.slice(nl + 1)];
    })
    .filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes('.'));
}

/**
 * What a rebase of HEAD onto `onto` (of the commits after `from`, when given) replays: git drops
 * merges (replaying the commits they brought in) and skips patches `onto` already has.
 * `onUpstream`: replayed commits already on `upstream`, which would need a force push.
 */
export async function readRebaseCounts(
  git: string,
  cwd: string,
  onto: string,
  upstream: string | undefined,
  from?: string,
): Promise<{ replay: number; merges: number; onUpstream: number }> {
  const after = from === undefined ? [] : [`^${from}`];
  const replayed = ['--no-merges', '--cherry-pick', '--right-only', `${onto}...HEAD`, ...after];
  const [replay, merges, notOnUpstream] = await Promise.all([
    count(git, cwd, replayed),
    count(git, cwd, ['--merges', `${onto}..HEAD`, ...after]),
    upstream === undefined ? Promise.resolve(0) : count(git, cwd, [...replayed, '--not', upstream]),
  ]);
  return { replay, merges, onUpstream: upstream === undefined ? 0 : replay - notOnUpstream };
}

export const isShallow = async (git: string, cwd: string): Promise<boolean> =>
  (await runGit(git, cwd, ['rev-parse', '--is-shallow-repository'])).trim() === 'true';

/** Untracked (or ignored) files at paths `target` has and HEAD does not: a hard reset overwrites them. */
export async function readUntrackedAt(git: string, cwd: string, target: string): Promise<string[]> {
  const added = (
    await runGit(git, cwd, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', 'HEAD', target, '--'])
  )
    .split('\0')
    .filter((p) => p !== '');
  const found: string[] = [];
  for (let i = 0; i < added.length; i += 500) {
    const chunk = added.slice(i, i + 500).map((p) => `:(literal)${p}`);
    const out = await runGit(git, cwd, ['ls-files', '--others', '-z', '--', ...chunk]);
    found.push(...out.split('\0').filter((p) => p !== ''));
  }
  return found;
}

/**
 * The untracked files git does not ignore at `paths` or inside them (an error's untrackedInTheWay);
 * undefined when one of `paths` has none, so the list was not what git meant.
 */
export async function readUntrackedIn(
  git: string,
  cwd: string,
  paths: readonly string[],
): Promise<string[] | undefined> {
  const found: string[] = [];
  for (let i = 0; i < paths.length; i += 500) {
    const chunk = paths.slice(i, i + 500).map((p) => `:(literal)${p}`);
    const out = await runGit(git, cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...chunk]);
    found.push(...out.split('\0').filter((p) => p !== ''));
  }
  const named = (p: string) => found.some((f) => f === p || f.startsWith(`${p}/`));
  return paths.length > 0 && paths.every(named) ? found : undefined;
}

/** A git config value as written; undefined when unset. */
export const readConfig = (git: string, cwd: string, key: string): Promise<string | undefined> =>
  optional(runGit(git, cwd, ['config', '--get', key]));

/** Branches checked out in other worktrees of the repository, by full ref, with the worktree's path. */
export async function readWorktreeBranches(git: string, cwd: string): Promise<Map<string, string>> {
  const [list, top] = await Promise.all([
    runGit(git, cwd, ['worktree', 'list', '--porcelain']),
    runGit(git, cwd, ['rev-parse', '--show-toplevel']).then((s) => s.trim()),
  ]);
  const found = new Map<string, string>();
  for (const block of list.split('\n\n')) {
    const path = /^worktree (.*)$/m.exec(block)?.[1];
    const branch = /^branch (.*)$/m.exec(block)?.[1];
    if (path !== undefined && branch !== undefined && path !== top) found.set(branch, path);
  }
  return found;
}
