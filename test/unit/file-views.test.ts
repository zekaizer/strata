import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { answersRequest, compareTarget, filesSummary, fileViews, type CommitDetails } from '../../src/core/details.ts';

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
      compared: false,
      root: false,
    });
  });
  it('names the first parent a merge is compared with', () => {
    assert.deepEqual(filesSummary(details([BASE, other], BASE, 2)), {
      text: '2 files changed',
      base: BASE,
      baseLabel: 'first parent',
      compared: false,
      root: false,
    });
  });
  it('says a base that is no parent is a commit compared with', () => {
    assert.deepEqual(filesSummary(details([BASE], other, 2)), {
      text: '2 files changed',
      base: other,
      baseLabel: '',
      compared: true,
      root: false,
    });
    assert.equal(filesSummary(details([], other, 2)).compared, true, 'a root commit compared with another');
  });
  it('names a second parent without a label, as a parent', () => {
    const s = filesSummary(details([BASE, other], other, 2));
    assert.deepEqual([s.baseLabel, s.compared], ['', false]);
  });
  it('says a root commit adds its files', () => {
    assert.deepEqual(filesSummary(details([], undefined, 3)), {
      text: '3 files added',
      base: undefined,
      baseLabel: '',
      compared: false,
      root: true,
    });
  });

  describe('compareTarget', () => {
    const other = 'b'.repeat(40);
    it('is the one selected commit, for every other commit', () => {
      assert.equal(compareTarget(BASE, false, other), BASE);
    });
    it('is none for the selected commit itself, without a selection, and with several selected', () => {
      assert.equal(compareTarget(BASE, false, BASE), '');
      assert.equal(compareTarget(undefined, false, other), '');
      assert.equal(compareTarget(BASE, true, other), '');
    });
  });

  describe('answersRequest', () => {
    const third = 'd'.repeat(40);
    const hash = 'c'.repeat(40);
    it('takes the details of the commit asked for, against its first parent when none was named', () => {
      assert.equal(answersRequest(details([BASE, other], BASE, 1), hash, undefined), true);
      assert.equal(answersRequest(details([], undefined, 1), hash, undefined), true);
      assert.equal(answersRequest(details([BASE], BASE, 1), other, undefined), false);
    });
    it('takes only the comparison asked for', () => {
      assert.equal(answersRequest(details([BASE], third, 1), hash, third), true);
      assert.equal(
        answersRequest(details([BASE], BASE, 1), hash, third),
        false,
        'the reply to an earlier plain select',
      );
      assert.equal(
        answersRequest(details([BASE], third, 1), hash, undefined),
        false,
        'the reply to an earlier compare',
      );
    });
  });
});
