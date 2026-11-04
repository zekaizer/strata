import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { EPOCH } from './builder.ts';

export interface StashSpec {
  /** Revision the stash is made on. */
  base: string;
  /** Branch HEAD was on; "(no branch)" when detached. */
  branch: string;
  /** The stash message; without one, git's "WIP on <branch>: <short> <subject>". */
  message?: string;
  /** What the stash reflog records instead of the stash commit's subject (git's autostash: "autostash"). */
  reflog?: string;
  /** Files in the index: path → content. */
  staged?: Record<string, string>;
  /** Tracked files changed in the working tree on top of the index. */
  worktree?: Record<string, string>;
  untracked?: Record<string, string>;
  /** Seconds after the fixture epoch. */
  time: number;
}

/** Fixed identity and date, and a private index: the same object ids on every run, the work tree untouched. */
function plumbing(dir: string, time: number): (args: string[], input?: string) => string {
  const when = `${EPOCH + time} +0000`;
  const index = resolve(dir, '.git', 'strata-fixture-index');
  rmSync(index, { force: true });
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Ada Lovelace',
    GIT_AUTHOR_EMAIL: 'ada@example.com',
    GIT_COMMITTER_NAME: 'Ada Lovelace',
    GIT_COMMITTER_EMAIL: 'ada@example.com',
    GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_DATE: when,
    GIT_INDEX_FILE: index,
  };
  return (args, input) => execFileSync('git', args, { cwd: dir, env, input, encoding: 'utf8' }).trim();
}

function tree(
  git: ReturnType<typeof plumbing>,
  from: string | undefined,
  ...layers: (Record<string, string> | undefined)[]
) {
  git(from === undefined ? ['read-tree', '--empty'] : ['read-tree', from]);
  for (const files of layers)
    for (const [path, content] of Object.entries(files ?? {})) {
      const blob = git(['hash-object', '-w', '--stdin'], content);
      git(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`]);
    }
  return git(['write-tree']);
}

/** A commit on `parent` that no ref reaches, like a branch's tip before a rebase or after the branch was deleted. */
export function commitAside(dir: string, parent: string, subject: string, files: Record<string, string>, time: number) {
  const git = plumbing(dir, time);
  return git(['commit-tree', tree(git, parent, files), '-p', parent, '-m', subject]);
}

/** Records a stash the way `git stash push` does (index commit, untracked commit), as stash@{0}. Returns its commit. */
export function storeStash(dir: string, s: StashSpec): string {
  const git = plumbing(dir, s.time);
  const base = git(['rev-parse', '--verify', `${s.base}^{commit}`]);
  const on = `${s.branch}: ${git(['log', '-1', '--format=%h %s', base])}`;
  const index = git(['commit-tree', tree(git, base, s.staged), '-p', base, '-m', `index on ${on}`]);
  const parents = ['-p', base, '-p', index];
  if (s.untracked)
    parents.push('-p', git(['commit-tree', tree(git, undefined, s.untracked), '-m', `untracked files on ${on}`]));
  const subject = s.message === undefined ? `WIP on ${on}` : `On ${s.branch}: ${s.message}`;
  const w = git(['commit-tree', tree(git, base, s.staged, s.worktree), ...parents, '-m', subject]);
  git(['stash', 'store', '-m', s.reflog ?? subject, w]);
  return w;
}

/**
 * Stashes for a repository with branchy's history, oldest first (the last is stash@{0}): one on a
 * commit no ref reaches, two on feature/search's tip, one on HEAD, and a git autostash whose base
 * the branch no longer contains (left over from a rebase).
 */
export function addBranchyStashes(dir: string): string[] {
  const spike = commitAside(dir, 'wip/experiment^', 'Old topic work', { 'old_topic.txt': 'old\n' }, 1900);
  const preRebase = commitAside(
    dir,
    'wip/experiment^',
    'Unmerged experiment',
    { 'wip_experiment.txt': 'Unmerged experiment, first try\n' },
    1910,
  );
  return [
    storeStash(dir, {
      base: spike,
      branch: 'old-topic',
      message: 'abandoned spike',
      worktree: { 'old_topic.txt': 'spike\n' },
      time: 2000,
    }),
    storeStash(dir, {
      base: 'feature/search',
      branch: 'feature/search',
      message: 'try a regex ranking',
      worktree: { 'feature_search.txt': 'Search ranking\nwith a regex\n' },
      time: 2100,
    }),
    storeStash(dir, {
      base: 'feature/search',
      branch: 'feature/search',
      message: 'half-done ranking UI',
      staged: { 'src/ranking.ts': 'export const rank = (n: number) => n;\n' },
      worktree: { 'feature_search.txt': 'Search ranking\nwith a UI\n', 'src/ranking.ts': 'export const rank = 1;\n' },
      untracked: { 'notes/ranking-ideas.md': '# Ranking ideas\n' },
      time: 2200,
    }),
    storeStash(dir, { base: 'main', branch: 'main', worktree: { 'NOTES.md': 'notes\nmore notes\n' }, time: 2300 }),
    storeStash(dir, {
      base: preRebase,
      branch: 'wip/experiment',
      message: 'autostash',
      reflog: 'autostash',
      worktree: { 'wip_experiment.txt': 'Unmerged experiment, first try\nlocal edit\n' },
      time: 2400,
    }),
  ];
}
