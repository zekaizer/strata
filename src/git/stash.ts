import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommitDetails } from '../core/details.ts';
import { parseStashList, type StashEntry } from '../core/stash.ts';
import { readChangedFiles, readCommitDetails } from './details.ts';
import { runGit } from './run.ts';

/** Stashes beyond this many are drawn at their base without checking their branch, and not counted. */
const MAX_CLASSIFIED = 32;

/** Answers that never change for a stash commit, or for a pair of base and branch tip; keep one per repository. */
export interface StashCache {
  files: Map<string, StashEntry['files']>;
  onBranch: Map<string, boolean>;
}

export const stashCache = (): StashCache => ({ files: new Map(), onBranch: new Map() });

/** The stash list as its reflog holds it, newest first, every stash at its base and uncounted; empty when there is none. */
export async function readStashList(git: string, cwd: string): Promise<StashEntry[]> {
  const exists = await runGit(git, cwd, ['rev-parse', '--verify', '--quiet', 'refs/stash']).then(
    () => true,
    () => false,
  );
  if (!exists) return [];
  return parseStashList(
    await runGit(git, cwd, [
      '-c',
      'log.showSignature=false',
      'log',
      '--walk-reflogs',
      '-z',
      '--no-color',
      '--encoding=UTF-8',
      '--format=%H%x00%P%x00%gd%x00%gs%x00%s%x00%ct',
      'refs/stash',
      '--',
    ]),
  );
}

/**
 * The stash list, newest first; empty when there is no stash. A stash whose base left the branch it
 * was made on, and which no branch, remote-tracking branch or HEAD (the graph's start points) still
 * holds, is anchored at that branch's tip. Checks that take longer than `budgetMs` in all leave their
 * stashes at their base, uncounted.
 */
export async function readStashes(
  git: string,
  cwd: string,
  cache: StashCache = stashCache(),
  budgetMs = 1500,
): Promise<StashEntry[]> {
  const [list, heads] = await Promise.all([
    readStashList(git, cwd),
    runGit(git, cwd, ['for-each-ref', '--format=%(refname:strip=2)%00%(objectname)', 'refs/heads']),
  ]);
  if (list.length === 0) return [];
  const tips = new Map(
    heads
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('\0') as [string, string]),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      resolve(undefined);
    }, budgetMs);
  });
  const classified = await Promise.all(
    list
      .slice(0, MAX_CLASSIFIED)
      .map((s) => Promise.race([classify(git, cwd, s, tips, cache).catch(() => s), deadline])),
  );
  clearTimeout(timer);
  return list.map((s, i) => classified[i] ?? s);
}

async function classify(
  git: string,
  cwd: string,
  s: StashEntry,
  tips: ReadonlyMap<string, string>,
  cache: StashCache,
): Promise<StashEntry> {
  const tip = s.branch === undefined ? undefined : tips.get(s.branch);
  const [onBranch, files] = await Promise.all([
    tip === undefined || tip === s.base ? true : isAncestor(git, cwd, s.base, tip, cache),
    countFiles(git, cwd, s, cache),
  ]);
  const displaced = tip !== undefined && !onBranch && !(await isDrawn(git, cwd, s.base));
  return { ...s, anchor: displaced ? { kind: 'tip', tip } : { kind: 'base' }, files };
}

/** Whether the graph's start points (LogReader's default) reach `commit`; not cached, since any ref moving changes it. */
async function isDrawn(git: string, cwd: string, commit: string): Promise<boolean> {
  const [byRef, byHead] = await Promise.all([
    runGit(git, cwd, ['for-each-ref', `--contains=${commit}`, '--count=1', '--format=x', 'refs/heads', 'refs/remotes']),
    runGit(git, cwd, ['merge-base', '--is-ancestor', commit, 'HEAD']).then(
      () => true,
      () => false,
    ),
  ]);
  return byRef.trim() !== '' || byHead;
}

async function isAncestor(git: string, cwd: string, base: string, tip: string, cache: StashCache): Promise<boolean> {
  const key = `${base} ${tip}`;
  let known = cache.onBranch.get(key);
  if (known === undefined) {
    // Exit status 1: not an ancestor.
    known = await runGit(git, cwd, ['merge-base', '--is-ancestor', base, tip]).then(
      () => true,
      () => false,
    );
    cache.onBranch.set(key, known);
  }
  return known;
}

async function countFiles(git: string, cwd: string, s: StashEntry, cache: StashCache): Promise<StashEntry['files']> {
  if (cache.files.has(s.hash)) return cache.files.get(s.hash);
  const count = (out: string) => out.split('\0').filter(Boolean).length;
  const [changed, untracked] = await Promise.all([
    runGit(git, cwd, ['diff-tree', '-r', '--no-commit-id', '--name-only', '-z', s.base, s.hash, '--']).then(count),
    s.untracked === undefined
      ? 0
      : runGit(git, cwd, ['ls-tree', '-r', '--name-only', '-z', s.untracked, '--']).then(count),
  ]);
  const files = { changed, untracked };
  cache.files.set(s.hash, files);
  return files;
}

/** The stash commit's details against its base, with what was staged and the untracked files. */
export async function readStashDetails(git: string, cwd: string, hash: string): Promise<CommitDetails> {
  const details = await readCommitDetails(git, cwd, hash);
  const [base, index, untracked] = details.parents;
  if (base === undefined || index === undefined) return details;
  const [staged, added] = await Promise.all([
    readChangedFiles(git, cwd, index, base),
    untracked === undefined ? undefined : readChangedFiles(git, cwd, untracked, undefined),
  ]);
  return {
    ...details,
    stash: {
      staged: staged.map((f) => f.path),
      untracked: untracked === undefined || !added ? undefined : { hash: untracked, files: added },
    },
  };
}

/** The identity git stash falls back to when none is configured, as commit-tree has no fallback. */
const STASH_IDENT = {
  GIT_AUTHOR_NAME: 'git stash',
  GIT_AUTHOR_EMAIL: 'git@stash',
  GIT_COMMITTER_NAME: 'git stash',
  GIT_COMMITTER_EMAIL: 'git@stash',
};

/**
 * A stash commit of `paths` as the index and the work tree have them, for `git stash store`.
 * `git stash push -- paths` refuses while any path is unmerged; this writes objects only, through a
 * temporary index, leaving the index, the work tree and every ref as they are. `message`: the
 * stash's message and reflog subject.
 */
export async function createStash(
  git: string,
  cwd: string,
  paths: readonly string[],
  message: string,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'strata-stash-'));
  const temp = (args: string[]) => runGit(git, cwd, args, { GIT_INDEX_FILE: join(dir, 'index') });
  try {
    const [head, staged, ident] = await Promise.all([
      runGit(git, cwd, ['rev-parse', '--verify', 'HEAD']).then((s) => s.trim()),
      runGit(git, cwd, ['ls-files', '--stage', '-z', '--', ...paths.map((p) => `:(literal)${p}`)]),
      runGit(git, cwd, ['var', 'GIT_COMMITTER_IDENT']).then(
        () => ({}),
        () => STASH_IDENT,
      ),
    ]);
    await temp(['read-tree', head]);
    const entries = staged
      .split('\0')
      .filter((e) => e !== '')
      .map((e) => {
        const [info = '', path = ''] = e.split('\t');
        const [mode = '', hash = ''] = info.split(' ');
        return { mode, hash, path };
      });
    for (const e of entries) await temp(['update-index', '--add', '--cacheinfo', e.mode, e.hash, e.path]);
    const gone = paths.filter((p) => !entries.some((e) => e.path === p));
    if (gone.length > 0) await temp(['update-index', '--force-remove', '--', ...gone]);
    const index = (await temp(['write-tree'])).trim();
    await temp(['update-index', '--add', '--remove', '--', ...paths]);
    const tree = (await temp(['write-tree'])).trim();
    const commit = async (args: string[]) => (await runGit(git, cwd, ['commit-tree', ...args], ident)).trim();
    const indexCommit = await commit([index, '-p', head, '-m', `index on ${message}`]);
    return await commit([tree, '-p', head, '-p', indexCommit, '-m', message]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
