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
  const exists = await runGit(git, cwd, ['rev-parse', '--verify', '--quiet', 'refs/stash']).then(
    () => true,
    () => false,
  );
  if (!exists) return [];
  const [out, heads] = await Promise.all([
    runGit(git, cwd, [
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
    runGit(git, cwd, ['for-each-ref', '--format=%(refname:strip=2)%00%(objectname)', 'refs/heads']),
  ]);
  const tips = new Map(
    heads
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('\0') as [string, string]),
  );
  const list = parseStashList(out);
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
