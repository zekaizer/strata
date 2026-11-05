import { access, open, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { GRAPH_HEADER_BYTES, graphChunks, hasBloomChunks } from '../core/commit-graph.ts';
import { runGit } from './run.ts';

/** The repository's single commit-graph file and split graph chain file, which may not exist. */
async function graphPaths(git: string, cwd: string): Promise<{ single: string; chain: string }> {
  // --git-path resolves to the common directory from linked worktrees.
  const out = await runGit(git, cwd, [
    'rev-parse',
    '--git-path',
    'objects/info/commit-graph',
    '--git-path',
    'objects/info/commit-graphs/commit-graph-chain',
  ]);
  const [single = '', chain = ''] = out
    .split('\n')
    .filter(Boolean)
    .map((p) => (isAbsolute(p) ? p : join(cwd, p)));
  return { single, chain };
}

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

/** Whether the repository has a commit-graph file, which lets git order history without reading all of it. */
export async function hasCommitGraph(git: string, cwd: string): Promise<boolean> {
  const { single, chain } = await graphPaths(git, cwd);
  return (await Promise.all([exists(single), exists(chain)])).some(Boolean);
}

/** The chunk ids of a commit-graph file, read from its first bytes. */
async function chunksOf(file: string): Promise<string[]> {
  const f = await open(file);
  try {
    const header = new Uint8Array(GRAPH_HEADER_BYTES);
    const { bytesRead } = await f.read(header, 0, header.length, 0);
    return graphChunks(header.subarray(0, bytesRead));
  } finally {
    await f.close();
  }
}

/**
 * Whether git can use changed-path (Bloom) filters for every commit of the commit-graph: what
 * makes the history of a file or folder fast. False without a commit-graph.
 */
export async function hasChangedPaths(git: string, cwd: string): Promise<boolean> {
  const { single, chain } = await graphPaths(git, cwd);
  // A split graph is used instead of a single file; each of its layers needs the filters.
  const layers = await readFile(chain, 'utf8').then(
    (text) =>
      text
        .split('\n')
        .filter(Boolean)
        .map((h) => join(dirname(chain), `graph-${h}.graph`)),
    () => [single],
  );
  const chunks = await Promise.all(layers.map((l) => chunksOf(l).catch(() => [])));
  return chunks.every(hasBloomChunks);
}

/**
 * Writes a commit-graph for all reachable commits (what `git maintenance` would do); with
 * `changedPaths`, with the changed-path filters file history needs, which later split writes keep.
 */
export async function writeCommitGraph(git: string, cwd: string, changedPaths = false): Promise<void> {
  await runGit(git, cwd, ['commit-graph', 'write', '--reachable', ...(changedPaths ? ['--changed-paths'] : [])]);
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
