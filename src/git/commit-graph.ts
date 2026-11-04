import { access } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { runGit } from './run.ts';

/** Whether the repository has a commit-graph file, which lets git order history without reading all of it. */
export async function hasCommitGraph(git: string, cwd: string): Promise<boolean> {
  // --git-path resolves to the common directory from linked worktrees.
  const out = await runGit(git, cwd, [
    'rev-parse',
    '--git-path',
    'objects/info/commit-graph',
    '--git-path',
    'objects/info/commit-graphs/commit-graph-chain',
  ]);
  const paths = out
    .split('\n')
    .filter(Boolean)
    .map((p) => (isAbsolute(p) ? p : join(cwd, p)));
  const found = await Promise.all(
    paths.map((p) =>
      access(p).then(
        () => true,
        () => false,
      ),
    ),
  );
  return found.some(Boolean);
}

/** Writes a commit-graph for all reachable commits (what `git maintenance` would do). */
export async function writeCommitGraph(git: string, cwd: string): Promise<void> {
  await runGit(git, cwd, ['commit-graph', 'write', '--reachable']);
}

/**
 * Adds commits that are not in the repository's commit-graph yet as a new layer of a split graph.
 * Does nothing (and returns false) when the repository has no commit-graph: creating one is the
 * user's call (see writeCommitGraph).
 */
export async function updateCommitGraph(git: string, cwd: string): Promise<boolean> {
  if (!(await hasCommitGraph(git, cwd))) return false;
  // --split writes only the missing commits (milliseconds on 1.5M-commit histories) and merges
  // small layers as git's own `fetch.writeCommitGraph` would.
  await runGit(git, cwd, ['commit-graph', 'write', '--reachable', '--split', '--no-progress']);
  return true;
}
