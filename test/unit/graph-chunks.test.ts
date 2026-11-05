import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { graphChunks, hasBloomChunks } from '../../src/core/commit-graph.ts';
import { hasChangedPaths, updateCommitGraph, writeCommitGraph } from '../../src/git/commit-graph.ts';
import { scenarios } from '../fixtures/scenarios.ts';
import { git, tempDir } from './helpers.ts';

const IDENTITY = ['-c', 'user.name=Ada Lovelace', '-c', 'user.email=ada@example.com'];

/** Adds a commit on main without touching the work tree. */
function commitOnMain(dir: string): void {
  const tip = git(dir, ...IDENTITY, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'new');
  git(dir, 'update-ref', 'refs/heads/main', tip);
}

describe('changed-path filters', () => {
  const root = tempDir('graph-chunks');

  it('reads the chunks of a commit-graph file', () => {
    const dir = join(root, 'plain');
    scenarios.linear().write(dir);
    git(dir, 'commit-graph', 'write', '--reachable');
    const chunks = graphChunks(readFileSync(join(dir, '.git', 'objects', 'info', 'commit-graph')));
    assert.ok(chunks.includes('OIDF') && chunks.includes('CDAT'), chunks.join());
    assert.equal(hasBloomChunks(chunks), false);
    assert.deepEqual(graphChunks(new TextEncoder().encode('PACK\0\0\0\0')), []);
    assert.deepEqual(graphChunks(new Uint8Array(3)), []);
  });

  it('tells a graph with them from one without and from none', async () => {
    const dir = join(root, 'detect');
    scenarios.linear().write(dir);
    assert.equal(await hasChangedPaths('git', dir), false, 'no commit-graph');
    await writeCommitGraph('git', dir);
    assert.equal(await hasChangedPaths('git', dir), false, 'plain');
    await writeCommitGraph('git', dir, true);
    assert.equal(await hasChangedPaths('git', dir), true, 'with --changed-paths');
  });

  it('keeps them when new commits are added as a split layer', async () => {
    const dir = join(root, 'split');
    scenarios.linear().write(dir);
    await writeCommitGraph('git', dir, true);
    commitOnMain(dir);
    assert.equal(await updateCommitGraph('git', dir), true);
    assert.equal(await hasChangedPaths('git', dir), true);
  });

  it('needs them in every layer of a split graph', async () => {
    const dir = join(root, 'mixed');
    scenarios.linear().write(dir);
    git(dir, 'commit-graph', 'write', '--reachable', '--split');
    commitOnMain(dir);
    git(dir, 'commit-graph', 'write', '--reachable', '--split=no-merge', '--changed-paths');
    assert.equal(await hasChangedPaths('git', dir), false);
  });
});
