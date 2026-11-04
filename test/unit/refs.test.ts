import * as assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { readRefs } from '../../src/git/refs.ts';
import { scenarios } from '../fixtures/scenarios.ts';
import { git, tempDir } from './helpers.ts';

describe('readRefs', () => {
  const root = tempDir('refs');
  const dir = join(root, 'refs');
  before(() => {
    scenarios.refs().write(dir);
  });

  it('classifies refs and peels annotated tags', async () => {
    const snap = await readRefs('git', dir);
    const byName = new Map(snap.refs.map((r) => [r.name, r]));
    assert.deepEqual(byName.get('refs/heads/main'), {
      name: 'refs/heads/main',
      short: 'main',
      kind: 'branch',
      hash: git(dir, 'rev-parse', 'main'),
    });
    assert.equal(byName.get('refs/remotes/origin/develop')!.kind, 'remote');
    assert.equal(byName.get('refs/remotes/origin/develop')!.short, 'origin/develop');
    const tag = byName.get('refs/tags/v0.1.0')!;
    assert.equal(tag.kind, 'tag');
    assert.equal(tag.short, 'v0.1.0');
    assert.equal(tag.hash, git(dir, 'rev-parse', 'v0.1.0^{commit}'));
    assert.equal(byName.get('refs/tags/lightweight-tag')?.hash, git(dir, 'rev-parse', 'lightweight-tag'));
  });

  it('lists the configured remotes', async () => {
    assert.deepEqual((await readRefs('git', dir)).remotes.sort(), ['origin', 'upstream']);
  });

  it('omits symbolic remote HEAD refs', async () => {
    git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    const snap = await readRefs('git', dir);
    assert.ok(!snap.refs.some((r) => r.name === 'refs/remotes/origin/HEAD'));
  });

  it('reports HEAD and the current branch', async () => {
    const snap = await readRefs('git', dir);
    assert.equal(snap.head, git(dir, 'rev-parse', 'HEAD'));
    assert.equal(snap.headBranch, 'main');
  });

  it('reports a detached HEAD without a branch', async () => {
    const d = join(root, 'detached');
    scenarios.linear().write(d);
    git(d, 'checkout', '--quiet', '--detach', 'HEAD~3');
    const snap = await readRefs('git', d);
    assert.equal(snap.head, git(d, 'rev-parse', 'HEAD'));
    assert.equal(snap.headBranch, undefined);
  });

  it('handles an unborn branch', async () => {
    const d = join(root, 'empty');
    mkdirSync(d);
    git(d, 'init', '--quiet', '-b', 'trunk');
    assert.deepEqual(await readRefs('git', d), { head: undefined, headBranch: 'trunk', refs: [], remotes: [] });
  });

  it('includes the stash', async () => {
    const d = join(root, 'stash');
    scenarios.linear().write(d);
    writeFileSync(join(d, 'untracked.txt'), 'x');
    git(d, '-c', 'user.name=a', '-c', 'user.email=a@b', 'stash', 'push', '--quiet', '--include-untracked');
    const stash = (await readRefs('git', d)).refs.find((r) => r.kind === 'stash');
    assert.deepEqual(stash, {
      name: 'refs/stash',
      short: 'stash',
      kind: 'stash',
      hash: git(d, 'rev-parse', 'refs/stash'),
    });
  });
});
