import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchCount, matchRanges, matchRefs, nextMatch, outOfView, parseFindQuery } from '../../src/core/find.ts';
import type { Ref, RefSnapshot } from '../../src/core/refs.ts';

describe('parseFindQuery', () => {
  it('reads plain text as a fixed string, trimmed', () => {
    assert.deepEqual(parseFindQuery('  descriptor leak  '), {
      text: 'descriptor leak',
      author: undefined,
      hashPrefix: undefined,
    });
  });

  it('has nothing to search for in blank input', () => {
    assert.equal(parseFindQuery(''), undefined);
    assert.equal(parseFindQuery('   '), undefined);
    assert.equal(parseFindQuery('author:'), undefined);
    assert.equal(parseFindQuery('author:""'), undefined);
  });

  it('reads 4 to 40 hex digits as a hash prefix too', () => {
    assert.deepEqual(parseFindQuery('E3A91F0'), { text: 'E3A91F0', author: undefined, hashPrefix: 'e3a91f0' });
    assert.equal(parseFindQuery('cafe')?.hashPrefix, 'cafe');
    assert.equal(parseFindQuery('caf')?.hashPrefix, undefined);
    assert.equal(parseFindQuery('a'.repeat(40))?.hashPrefix, 'a'.repeat(40));
    assert.equal(parseFindQuery('a'.repeat(41))?.hashPrefix, undefined);
    assert.equal(parseFindQuery('cafe babe')?.hashPrefix, undefined);
    assert.equal(parseFindQuery('xcafe')?.hashPrefix, undefined);
  });

  it('reads author: anywhere, quoted when it holds spaces, with the rest as text', () => {
    assert.deepEqual(parseFindQuery('author:ada'), { text: '', author: 'ada', hashPrefix: undefined });
    assert.deepEqual(parseFindQuery('fix author:"Ada Lovelace" leak'), {
      text: 'fix leak',
      author: 'Ada Lovelace',
      hashPrefix: undefined,
    });
    assert.deepEqual(parseFindQuery('Author:ada b384'), { text: 'b384', author: 'ada', hashPrefix: undefined });
  });

  it('reads an unclosed quote to the end, as typing it leaves it', () => {
    assert.deepEqual(parseFindQuery('author:"Ada Lo'), { text: '', author: 'Ada Lo', hashPrefix: undefined });
  });

  it('keeps author: inside a word as text', () => {
    assert.equal(parseFindQuery('coauthor:ada')?.author, undefined);
    assert.equal(parseFindQuery('coauthor:ada')?.text, 'coauthor:ada');
  });

  it('does not read a hash with an author given', () => {
    assert.equal(parseFindQuery('author:ada cafe')?.hashPrefix, undefined);
  });
});

describe('matchRefs', () => {
  const ref = (name: string, kind: Ref['kind']): Ref => ({
    name,
    short: name.replace(/^refs\/(heads|remotes|tags)\//, ''),
    kind,
    hash: '0'.repeat(40),
  });
  const snapshot: RefSnapshot = {
    head: '0'.repeat(40),
    headBranch: 'b384-fix',
    refs: [
      ref('refs/tags/v1-b384', 'tag'),
      ref('refs/remotes/origin/b384', 'remote'),
      ref('refs/heads/b384', 'branch'),
      ref('refs/heads/b384-fix', 'branch'),
      ref('refs/heads/main', 'branch'),
    ],
    remotes: ['origin'],
  };

  it('lists refs whose short name contains the text: current branch, branches, remotes, tags', () => {
    assert.deepEqual(
      matchRefs(snapshot, 'B384').map((r) => r.short),
      ['b384-fix', 'b384', 'origin/b384', 'v1-b384'],
    );
  });

  it('matches nothing for empty text', () => {
    assert.deepEqual(matchRefs(snapshot, ''), []);
  });
});

describe('matchRanges', () => {
  it('finds every occurrence, ignoring case', () => {
    assert.deepEqual(matchRanges('Merge b384 into B384-x', 'b384'), [
      [6, 10],
      [16, 20],
    ]);
  });

  it('does not overlap occurrences', () => {
    assert.deepEqual(matchRanges('aaaa', 'aa'), [
      [0, 2],
      [2, 4],
    ]);
  });

  it('finds nothing for an empty needle', () => {
    assert.deepEqual(matchRanges('abc', ''), []);
  });
});

describe('nextMatch', () => {
  // Loaded rows: a0..a9 at 0..9; x and y are not loaded yet.
  const pos = (h: string) => (h.startsWith('a') ? Number(h.slice(1)) : undefined);
  const matches = ['a2', 'a5', 'a8', 'x', 'y'];
  const next = (current: string | undefined, from: number, back = false, done = true) =>
    nextMatch(matches, pos, { current, from }, back, done);

  it('steps through the matches from the current one', () => {
    assert.equal(next('a5', 5), 'a8');
    assert.equal(next('a8', 8), 'x');
    assert.equal(next('x', 99), 'y');
    assert.equal(next('a5', 5, true), 'a2');
  });

  it('wraps around once the search is done, and waits for more otherwise', () => {
    assert.equal(next('y', 99), 'a2');
    assert.equal(next('y', 99, false, false), undefined);
    assert.equal(next('a2', 2, true), 'y');
  });

  it('goes to the nearest match below or above a row that is not one', () => {
    assert.equal(next(undefined, 3), 'a5');
    assert.equal(next(undefined, 3, true), 'a2');
    assert.equal(next(undefined, -1), 'a2');
    assert.equal(next(undefined, 9), 'x', 'the first one not loaded yet');
    assert.equal(next(undefined, 1, true), 'y', 'wraps to the last');
  });

  it('counts a match listed first but further down by where it is', () => {
    const exactFirst = ['x', 'a2', 'a5'];
    assert.equal(nextMatch(exactFirst, pos, { current: undefined, from: 3 }, false, true), 'a5');
    assert.equal(nextMatch(exactFirst, pos, { current: undefined, from: 6 }, false, true), 'x');
    assert.equal(nextMatch(exactFirst, pos, { current: 'x', from: 99 }, false, true), 'a2');
  });

  it('has nowhere to go without matches', () => {
    assert.equal(nextMatch([], pos, { current: undefined, from: 0 }, false, true), undefined);
  });
});

describe('matchCount', () => {
  it('says where the current match is among all', () => {
    assert.equal(matchCount(21, 3, false), '3 of 21');
    assert.equal(matchCount(21, undefined, false), '? of 21');
    assert.equal(matchCount(10_000, 7, true), '7 of 10,000+');
  });

  it('says when nothing matched, or nothing yet', () => {
    assert.equal(matchCount(0, undefined, false), 'No results');
    assert.equal(matchCount(0, undefined, true), 'Searching…');
  });
});

describe('outOfView', () => {
  const all = { refs: null, firstParent: false };
  const picked = { refs: ['refs/heads/main'], firstParent: false };

  it('offers all parents when only first-parent following leaves it out', () => {
    assert.deepEqual(outOfView(['refs/heads/main'], { ...all, firstParent: true }), {
      text: 'it is not on the first-parent line.',
      action: { label: 'Show All Parents', firstParent: false },
    });
    assert.equal(outOfView(['refs/heads/main'], { ...picked, firstParent: true }).action?.label, 'Show All Parents');
  });

  it('only says why when every branch is shown', () => {
    assert.deepEqual(outOfView(['refs/tags/v1.4-rc2'], all), {
      text: 'only tag v1.4-rc2 reaches it, and the graph starts from branches, not tags.',
    });
    assert.deepEqual(outOfView(['refs/tags/v1', 'refs/tags/v2', 'refs/tags/v3', 'refs/tags/v4'], all), {
      text: 'only tags v1, v2, v3 and 1 more reach it, and the graph starts from branches, not tags.',
    });
    assert.deepEqual(outOfView([], all), { text: 'no branch or tag reaches it.' });
  });

  it('offers to add a branch, else a remote branch, else a tag, to a selection', () => {
    assert.deepEqual(outOfView(['refs/tags/v1', 'refs/remotes/origin/dev', 'refs/heads/dev'], picked), {
      text: 'the branch filter leaves it out.',
      action: { label: 'Show dev Too', refs: ['refs/heads/main', 'refs/heads/dev'] },
    });
    assert.equal(outOfView(['refs/tags/v1', 'refs/remotes/origin/dev'], picked).action?.label, 'Show origin/dev Too');
    assert.deepEqual(outOfView(['refs/tags/v1'], picked).action, {
      label: 'Show v1 Too',
      refs: ['refs/heads/main', 'refs/tags/v1'],
    });
    assert.deepEqual(outOfView([], picked), { text: 'no branch or tag reaches it.' });
  });
});
