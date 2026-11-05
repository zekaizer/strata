import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { holders, parseWorktreeList, samePath, type WorktreeInfo } from '../../src/core/worktrees.ts';

const A = 'b0e316ab2b147cd52cee73b00c821e0b79b19bcb';
const UNBORN = '0000000000000000000000000000000000000000';

// `git worktree list --porcelain` of git 2.34.1: main, detached, branch, prunable, locked (with and
// without a reason), unborn.
const LIST = [
  `worktree /w/repo\nHEAD ${A}\nbranch refs/heads/main\n`,
  `worktree /w/wt-det\nHEAD ${A}\ndetached\n`,
  `worktree /w/wt-feat\nHEAD ${A}\nbranch refs/heads/feat\n`,
  `worktree /w/wt-gone\nHEAD ${A}\nbranch refs/heads/gone\nprunable gitdir file points to non-existent location\n`,
  `worktree /w/wt-usb\nHEAD ${A}\nbranch refs/heads/review\nlocked on usb disk\n`,
  `worktree /w/wt-lock\nHEAD ${A}\nbranch refs/heads/locked\nlocked\n`,
  `worktree /w/wt-unborn\nHEAD ${UNBORN}\nbranch refs/heads/fresh\n`,
].join('\n');

const wt = (path: string, rest: Partial<WorktreeInfo>): WorktreeInfo => ({
  path,
  name: path.split('/').at(-1)!,
  head: A,
  branch: undefined,
  state: { kind: 'active' },
  main: false,
  ...rest,
});

describe('parseWorktreeList', () => {
  it('reads every worktree, its HEAD, branch and whether it is locked or prunable', () => {
    assert.deepEqual(parseWorktreeList(LIST), [
      wt('/w/repo', { branch: 'refs/heads/main', main: true }),
      wt('/w/wt-det', {}),
      wt('/w/wt-feat', { branch: 'refs/heads/feat' }),
      wt('/w/wt-gone', {
        branch: 'refs/heads/gone',
        state: { kind: 'prunable', reason: 'gitdir file points to non-existent location' },
      }),
      wt('/w/wt-usb', { branch: 'refs/heads/review', state: { kind: 'locked', reason: 'on usb disk' } }),
      wt('/w/wt-lock', { branch: 'refs/heads/locked', state: { kind: 'locked', reason: undefined } }),
      wt('/w/wt-unborn', { branch: 'refs/heads/fresh', head: undefined }),
    ]);
  });

  it('leaves out a bare main repository, which has no work tree', () => {
    const list = `worktree /w/repo.git\nbare\n\nworktree /w/linked\nHEAD ${A}\nbranch refs/heads/x\n\n`;
    assert.deepEqual(parseWorktreeList(list), [wt('/w/linked', { branch: 'refs/heads/x' })]);
  });

  it('decodes a lock reason git quoted', () => {
    const list = `worktree /w/repo\nHEAD ${A}\ndetached\n\nworktree /w/b\nHEAD ${A}\ndetached\nlocked "two\\nlines \\"q\\""\n`;
    assert.deepEqual(parseWorktreeList(list)[1]?.state, { kind: 'locked', reason: 'two\nlines "q"' });
  });

  it('names a worktree by its folder, also on Windows', () => {
    const list = `worktree C:/src/repo\nHEAD ${A}\ndetached\n\nworktree C:/src/review\nHEAD ${A}\ndetached\n`;
    assert.deepEqual(
      parseWorktreeList(list).map((w) => w.name),
      ['repo', 'review'],
    );
  });

  it('reads nothing from no output', () => {
    assert.deepEqual(parseWorktreeList(''), []);
  });
});

describe('holders', () => {
  it('maps each branch to the worktree that has it checked out, prunable ones included', () => {
    const list = parseWorktreeList(LIST);
    const held = holders(list);
    assert.deepEqual(
      [...held.keys()],
      [
        'refs/heads/main',
        'refs/heads/feat',
        'refs/heads/gone',
        'refs/heads/review',
        'refs/heads/locked',
        'refs/heads/fresh',
      ],
    );
    assert.equal(held.get('refs/heads/gone')?.path, '/w/wt-gone');
  });
});

describe('samePath', () => {
  it('compares a path git prints with a file system path', () => {
    assert.ok(samePath('/w/repo', '/w/repo'));
    assert.ok(samePath('C:/src/repo', 'c:\\src\\repo'));
    assert.ok(!samePath('/w/repo', '/w/repo2'));
    assert.ok(!samePath('/w/Repo', '/w/repo'));
  });
});
