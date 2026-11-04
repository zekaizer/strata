import { parseStashList, type StashEntry } from '../core/stash.ts';
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
 * The stash list, newest first; empty when there is no stash. Each stash whose base is no longer
 * on the branch it was made on is anchored at that branch's tip. Checks that take longer than
 * `budgetMs` in all leave their stashes at their base, uncounted.
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
  return { ...s, anchor: onBranch || tip === undefined ? { kind: 'base' } : { kind: 'tip', tip }, files };
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
