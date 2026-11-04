import * as assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { hasCommitGraph, writeCommitGraph } from '../../src/git/commit-graph.ts';
import { scenarios } from '../fixtures/scenarios.ts';
import { git, tempDir } from './helpers.ts';

describe('commit-graph', () => {
  const root = tempDir('commit-graph');

  it('detects a missing graph and writes one', async () => {
    const dir = join(root, 'single');
    scenarios.branchy().write(dir);
    assert.equal(await hasCommitGraph('git', dir), false);
    await writeCommitGraph('git', dir);
    assert.equal(await hasCommitGraph('git', dir), true);
    git(dir, 'commit-graph', 'verify');
  });

  it('detects a split (chained) graph', async () => {
    const dir = join(root, 'split');
    scenarios.linear().write(dir);
    git(dir, 'commit-graph', 'write', '--reachable', '--split');
    assert.equal(await hasCommitGraph('git', dir), true);
  });

  it('looks in the common directory from a linked worktree', async () => {
    const dir = join(root, 'main-wt');
    scenarios.linear().write(dir);
    git(dir, 'commit-graph', 'write', '--reachable');
    const wt = join(root, 'linked-wt');
    git(dir, 'worktree', 'add', '--quiet', '--detach', wt);
    assert.equal(await hasCommitGraph('git', wt), true);
  });
});
