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
      upstream: 'refs/remotes/origin/main',
      tracks: true,
    });
    assert.equal(byName.get('refs/remotes/origin/develop')!.kind, 'remote');
    assert.equal(byName.get('refs/remotes/origin/develop')!.short, 'origin/develop');
    const tag = byName.get('refs/tags/v0.1.0')!;
    assert.equal(tag.kind, 'tag');
    assert.equal(tag.short, 'v0.1.0');
    assert.equal(tag.hash, git(dir, 'rev-parse', 'v0.1.0^{commit}'));
    assert.equal(byName.get('refs/tags/lightweight-tag')?.hash, git(dir, 'rev-parse', 'lightweight-tag'));
  });

  it("reads a branch's upstream, and none for a branch without one", async () => {
    git(dir, 'branch', '--quiet', '--set-upstream-to=origin/release/0.2', 'release/0.2');
    const byName = new Map((await readRefs('git', dir)).refs.map((r) => [r.name, r]));
    assert.equal(byName.get('refs/heads/release/0.2')?.upstream, 'refs/remotes/origin/release/0.2');
    assert.equal(byName.get('refs/heads/develop')?.upstream, undefined);
    assert.equal(byName.get('refs/remotes/origin/main')?.upstream, undefined);
  });

  it('tells a branch with an upstream configured but no remote-tracking branch for it: a URL remote, or one the refspec leaves out', async () => {
    const d = join(root, 'tracks');
    scenarios.refs().write(d);
    git(d, 'branch', 'by-url', 'main');
    git(d, 'config', 'branch.by-url.remote', 'https://example.invalid/fork.git');
    git(d, 'config', 'branch.by-url.merge', 'refs/heads/feature');
    git(d, 'branch', 'unfetched', 'main');
    git(d, 'remote', 'add', '-t', 'main', 'narrow', 'https://example.invalid/narrow.git');
    git(d, 'config', 'branch.unfetched.remote', 'narrow');
    git(d, 'config', 'branch.unfetched.merge', 'refs/heads/feature');
    git(d, 'branch', 'no-remote', 'main');
    git(d, 'config', 'branch.no-remote.merge', 'refs/heads/feature');
    const byName = new Map((await readRefs('git', d)).refs.map((r) => [r.short, r]));
    for (const b of ['by-url', 'unfetched']) {
      assert.equal(byName.get(b)?.tracks, true, b);
      assert.equal(byName.get(b)?.upstream, undefined, b);
    }
    for (const b of ['no-remote', 'develop', 'origin/main']) assert.equal(byName.get(b)?.tracks, undefined, b);
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
    assert.deepEqual(await readRefs('git', d), {
      head: undefined,
      headBranch: 'trunk',
      refs: [],
      remotes: [],
      worktrees: [],
    });
  });

  it("lists the repository's other worktrees", async () => {
    const d = join(root, 'worktrees');
    scenarios.linear().write(d);
    const other = join(root, 'worktrees-other');
    git(d, 'worktree', 'add', '--quiet', '--detach', other, 'HEAD~1');
    const snap = await readRefs('git', d);
    assert.deepEqual(snap.worktrees, [
      {
        path: other,
        name: 'worktrees-other',
        head: git(d, 'rev-parse', 'HEAD~1'),
        branch: undefined,
        state: { kind: 'active' },
        main: false,
      },
    ]);
  });

  it('leaves the stash out: it is read with the stash list', async () => {
    const d = join(root, 'stash');
    scenarios.linear().write(d);
    writeFileSync(join(d, 'untracked.txt'), 'x');
    git(d, '-c', 'user.name=a', '-c', 'user.email=a@b', 'stash', 'push', '--quiet', '--include-untracked');
    const snap = await readRefs('git', d);
    assert.deepEqual(
      snap.refs.map((r) => r.name),
      ['refs/heads/main'],
    );
  });
});
