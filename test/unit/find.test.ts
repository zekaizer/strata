import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchRanges, matchRefs, parseFindQuery } from '../../src/core/find.ts';
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
