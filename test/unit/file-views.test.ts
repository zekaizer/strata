import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { filesSummary, fileViews, type CommitDetails } from '../../src/core/details.ts';

const BASE = 'a'.repeat(40);

describe('fileViews', () => {
  it('offers diff, before and after for modified and renamed files', () => {
    assert.deepEqual(fileViews({ status: 'M', path: 'a' }, BASE), ['diff', 'before', 'after']);
    assert.deepEqual(fileViews({ status: 'R', path: 'b', oldPath: 'a' }, BASE), ['diff', 'before', 'after']);
  });
  it('offers only the side that exists for added and deleted files', () => {
    assert.deepEqual(fileViews({ status: 'A', path: 'a' }, BASE), ['after']);
    assert.deepEqual(fileViews({ status: 'D', path: 'a' }, BASE), ['before']);
  });
  it('treats files of a root commit as added', () => {
    assert.deepEqual(fileViews({ status: 'M', path: 'a' }, undefined), ['after']);
  });
});

describe('filesSummary', () => {
  const details = (parents: string[], base: string | undefined, n: number): CommitDetails => ({
    hash: 'c'.repeat(40),
    parents,
    author: 'A',
    authorEmail: 'a@example.com',
    authorTime: 0,
    committer: 'A',
    committerEmail: 'a@example.com',
    commitTime: 0,
    message: 's',
    parentSubjects: parents.map(() => 'p'),
    base,
    files: Array.from({ length: n }, (_, i) => ({ status: 'M' as const, path: `f${i}` })),
  });
  const other = 'b'.repeat(40);
  it('names the only parent as the base', () => {
    assert.deepEqual(filesSummary(details([BASE], BASE, 1)), {
      text: '1 file changed',
      base: BASE,
      baseLabel: '',
      root: false,
    });
  });
  it('names the first parent a merge is compared with', () => {
    assert.deepEqual(filesSummary(details([BASE, other], BASE, 2)), {
      text: '2 files changed',
      base: BASE,
      baseLabel: 'first parent',
      root: false,
    });
  });
  it('names any other base without a label', () => {
    assert.deepEqual(filesSummary(details([BASE], other, 2)), {
      text: '2 files changed',
      base: other,
      baseLabel: '',
      root: false,
    });
    assert.deepEqual(filesSummary(details([BASE, other], other, 2)).baseLabel, '');
  });
  it('says a root commit adds its files', () => {
    assert.deepEqual(filesSummary(details([], undefined, 3)), {
      text: '3 files added',
      base: undefined,
      baseLabel: '',
      root: true,
    });
  });
});
