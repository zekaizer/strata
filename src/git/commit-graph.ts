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
