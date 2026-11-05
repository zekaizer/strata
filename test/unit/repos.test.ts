import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseRepoKey, pickRepo, sortRepos, type RepoKey } from '../../src/core/repos.ts';

const key = (s: string) => s as RepoKey;
const [a, b, c] = [key('/w/a'), key('/w/b'), key('/w/b/vendor/c')];

describe('pickRepo', () => {
  const open = [a, b, c];

  it('prefers the chosen repository, then the restored, the shown and the active one', () => {
    assert.equal(pickRepo(open, { chosen: c, restored: b, shown: a, active: a }), c);
    assert.equal(pickRepo(open, { restored: b, shown: a, active: c }), b);
    assert.equal(pickRepo(open, { shown: c, active: b }), c);
    assert.equal(pickRepo(open, { active: b }), b);
  });

  it('falls back to the first of the list', () => {
    assert.equal(pickRepo(open, {}), a);
    assert.equal(pickRepo([], { chosen: a }), undefined);
  });

  it('skips a restored repository that is not open yet, and shows it once it is', () => {
    assert.equal(pickRepo([a, b], { restored: c, active: b }), b);
    assert.equal(pickRepo([a, b, c], { restored: c, shown: b, active: b }), c);
  });

  it('moves on when the shown repository closed', () => {
    assert.equal(pickRepo([a, c], { shown: b, active: c }), c);
    assert.equal(pickRepo([a, c], { shown: b }), a);
  });

  it('never returns what the webview named unless it is open', () => {
    assert.equal(pickRepo([a, b], { chosen: '/elsewhere', restored: '../w/b' }), a);
  });
});

describe('sortRepos', () => {
  const repos = [
    { key: c, name: 'c' },
    { key: b, name: 'b' },
    { key: a, name: 'Z' },
  ];

  it('orders by the sequence repositories were first seen in', () => {
    const seen = new Map([
      [b, 0],
      [c, 1],
      [a, 2],
    ]);
    assert.deepEqual(
      sortRepos(repos, 'discoveryTime', seen).map((r) => r.key),
      [b, c, a],
    );
  });

  it('puts repositories not seen yet last, by path', () => {
    assert.deepEqual(
      sortRepos(repos, 'discoveryTime', new Map([[c, 0]])).map((r) => r.key),
      [c, a, b],
    );
  });

  it('orders by name or by path', () => {
    assert.deepEqual(
      sortRepos(repos, 'name', new Map()).map((r) => r.key),
      [b, c, a],
    );
    assert.deepEqual(
      sortRepos(repos, 'path', new Map()).map((r) => r.key),
      [a, b, c],
    );
  });
});

describe('parseRepoKey', () => {
  it('accepts only the root of an open repository', () => {
    assert.equal(parseRepoKey('/w/b', [a, b]), b);
    assert.equal(parseRepoKey('/w/b/', [a, b]), undefined);
    assert.equal(parseRepoKey('/w/c', [a, b]), undefined);
    assert.equal(parseRepoKey(3, [a, b]), undefined);
    assert.equal(parseRepoKey(undefined, [a, b]), undefined);
  });
});
