import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  inFilter,
  MAX_FILTER_PATHS,
  parentFolder,
  parsePathFilter,
  pathLabel,
  withPath,
  type PathFilter,
  type RepoPath,
} from '../../src/core/path-filter.ts';

const f = (...paths: string[]): PathFilter => parsePathFilter({ paths })!;

describe('path filter', () => {
  it('accepts repository-relative files and folders, without duplicates', () => {
    assert.deepEqual(parsePathFilter({ paths: ['src/a.ts', 'src/', 'src/a.ts'] }), { paths: ['src/a.ts', 'src/'] });
    assert.deepEqual(parsePathFilter({ paths: [':magic', 'a*b'] }), { paths: [':magic', 'a*b'] });
  });

  it('refuses anything that could leave the repository or is not a path', () => {
    for (const paths of [[], [''], ['/etc/passwd'], ['../x'], ['a/../b'], ['a//b'], ['./a'], ['a\\b'], ['/'], [1]])
      assert.equal(parsePathFilter({ paths }), undefined, JSON.stringify(paths));
    for (const raw of [undefined, null, 'src/a.ts', { paths: 'src/a.ts' }])
      assert.equal(parsePathFilter(raw), undefined);
    const many = Array.from({ length: MAX_FILTER_PATHS + 1 }, (_, i) => `f${i}`);
    assert.equal(parsePathFilter({ paths: many }), undefined);
  });

  it('tells which changed files a filter covers', () => {
    assert.ok(inFilter('src/auth/session.ts', f('src/auth/session.ts')));
    assert.ok(!inFilter('src/auth/session.tsx', f('src/auth/session.ts')));
    assert.ok(inFilter('src/auth/deep/x.ts', f('src/auth/')));
    assert.ok(!inFilter('src/authz/x.ts', f('src/auth/')));
    assert.ok(inFilter('src/session.ts', f('src/auth/session.ts', 'src/session.ts')));
  });

  it('labels the chip with the picked name and the count of older names', () => {
    assert.equal(pathLabel(f('src/auth/session.ts')), 'session.ts');
    assert.equal(pathLabel(f('src/auth/')), 'auth/');
    assert.equal(pathLabel(f('README.md')), 'README.md');
    assert.equal(pathLabel(f('src/auth/session.ts', 'src/session.ts')), 'session.ts +1');
  });

  it('adds an older name once', () => {
    const one = f('src/auth/session.ts');
    const two = withPath(one, 'src/session.ts' as RepoPath);
    assert.deepEqual(two.paths, ['src/auth/session.ts', 'src/session.ts']);
    assert.equal(withPath(two, 'src/session.ts' as RepoPath), two);
  });

  it('names the parent folder of a file or folder', () => {
    assert.equal(parentFolder('src/auth/session.ts' as RepoPath), 'src/auth/');
    assert.equal(parentFolder('src/auth/' as RepoPath), 'src/');
    assert.equal(parentFolder('README.md' as RepoPath), undefined);
  });
});
