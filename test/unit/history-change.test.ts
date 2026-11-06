import * as assert from 'node:assert/strict';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { historyChange, historyStarts, type RefSnapshot } from '../../src/core/refs.ts';
import { allReachable, readRefs } from '../../src/git/refs.ts';
import { scenarios } from '../fixtures/scenarios.ts';
import { git, tempDir } from './helpers.ts';

const snapshot = (refs: [string, string][], head?: string, worktreeHeads: string[] = []): RefSnapshot => ({
  head,
  headBranch: undefined,
  refs: refs.map(([name, hash]) => ({
    name,
    short: name.replace(/^refs\/(heads|remotes|tags)\//, ''),
    kind: name.startsWith('refs/heads/') ? 'branch' : name.startsWith('refs/remotes/') ? 'remote' : 'tag',
    hash,
  })),
  remotes: [],
  worktrees: worktreeHeads.map((h, i) => ({
    path: `/w${i}`,
    name: `w${i}`,
    head: h,
    branch: undefined,
    state: { kind: 'active' },
    main: false,
  })),
});

describe('historyStarts', () => {
  const snap = snapshot(
    [
      ['refs/heads/main', 'a'],
      ['refs/remotes/origin/main', 'b'],
      ['refs/tags/v1', 'c'],
    ],
    'd',
    ['e'],
  );

  it('starts from branches, remote-tracking branches, HEAD and detached worktrees, not tags', () => {
    assert.deepEqual([...historyStarts(snap, null, false)].sort(), ['a', 'b', 'd', 'e']);
  });

  it('starts from the picked refs only, tags too; a path history keeps HEAD', () => {
    assert.deepEqual([...historyStarts(snap, ['refs/tags/v1'], false)], ['c']);
    assert.deepEqual([...historyStarts(snap, ['refs/tags/v1'], true)].sort(), ['c', 'd']);
  });
});

describe('historyChange', () => {
  const all = { firstParent: false, path: false };
  const s = (...h: string[]) => new Set(h);

  it('is the same history when the starts are the same commits', () => {
    assert.deepEqual(historyChange(s('a', 'b'), s('b', 'a'), s(), { firstParent: true, path: true }), {
      kind: 'same',
    });
  });

  it('is the same history when a start is added at a commit already served', () => {
    assert.deepEqual(historyChange(s('a'), s('a', 'x'), s('a', 'x'), { firstParent: true, path: false }), {
      kind: 'same',
    });
  });

  it('asks about added commits not served and removed starts', () => {
    assert.deepEqual(historyChange(s('a', 'r'), s('a', 'x', 'y'), s('y'), all), {
      kind: 'check',
      added: ['x'],
      removed: ['r'],
    });
  });

  it('reloads a path history whose starts change, and a first-parent one ancestry cannot answer', () => {
    assert.deepEqual(historyChange(s('a'), s('a', 'x'), s('x'), { firstParent: false, path: true }), {
      kind: 'reload',
    });
    assert.deepEqual(historyChange(s('a', 'r'), s('a'), s(), { firstParent: true, path: false }), { kind: 'reload' });
    assert.deepEqual(historyChange(s('a'), s('a', 'x'), s(), { firstParent: true, path: false }), { kind: 'reload' });
  });
});

describe('allReachable', () => {
  const dir = join(tempDir('reachable'), 'branchy');
  before(() => {
    scenarios.branchy().write(dir);
  });

  it('tells whether commits are in the history of others', async () => {
    const rev = (r: string) => git(dir, 'rev-parse', r);
    assert.equal(await allReachable('git', dir, [rev('main~3'), rev('feature/login')], [rev('main')]), true);
    assert.equal(await allReachable('git', dir, [rev('wip/experiment')], [rev('main')]), false);
    assert.equal(await allReachable('git', dir, [], [rev('main')]), true);
    assert.equal(await allReachable('git', dir, ['0'.repeat(40)], [rev('main')]), false, 'a missing commit');
  });

  it('gives the same history for a start added inside it, as git log reads it', async () => {
    const view = async () =>
      git(dir, 'log', '--topo-order', '--format=%H', ...[...historyStarts(await readRefs('git', dir), null, false)]);
    const was = await view();
    git(dir, 'branch', 'inside', 'main~4');
    assert.equal(await view(), was);
  });
});
