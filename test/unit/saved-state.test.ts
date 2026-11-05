import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_OPTIONS } from '../../src/shared/protocol.ts';
import {
  parseSaved,
  remember,
  REMEMBERED_REPOS,
  savedOptions,
  viewOf,
  type SavedState,
} from '../../src/webview/saved-state.ts';

const firstParent = { ...DEFAULT_OPTIONS, firstParent: true };

describe('saved state', () => {
  it('keeps a view per repository and names the last one shown', () => {
    let s: SavedState = {};
    s = remember(s, '/w/a', { selectedHash: 'aaa', options: firstParent });
    s = remember(s, '/w/b', { selectedHash: 'bbb' });
    assert.equal(s.last, '/w/b');
    assert.equal(viewOf(s, '/w/a')?.selectedHash, 'aaa');
    assert.equal(viewOf(s, '/w/b')?.selectedHash, 'bbb');
    assert.equal(viewOf(s, '/w/c'), undefined);
    assert.deepEqual(savedOptions(s), { '/w/a': firstParent });
  });

  it('forgets the least recently shown repositories past the cap', () => {
    let s: SavedState = {};
    for (let i = 0; i <= REMEMBERED_REPOS; i++) s = remember(s, `/w/${i}`, { selectedHash: String(i) });
    s = remember(s, '/w/1', { selectedHash: 'again' });
    assert.equal(s.repos?.length, REMEMBERED_REPOS);
    assert.equal(viewOf(s, '/w/0'), undefined);
    assert.equal(viewOf(s, '/w/1')?.selectedHash, 'again');
    assert.equal(s.last, '/w/1');
  });

  it('reads a state saved before views were per repository as the view of no repository yet', () => {
    const old = { selectedHash: 'abc', scrollTop: 40, expanded: true, metaOpen: true, options: firstParent };
    const { state, unkeyed } = parseSaved(old);
    assert.deepEqual(state, { metaOpen: true });
    assert.deepEqual(unkeyed, { selectedHash: 'abc', scrollTop: 40, expanded: true, options: firstParent });
  });

  it('drops what is not a saved state', () => {
    assert.deepEqual(parseSaved(undefined), { state: {}, unkeyed: undefined });
    assert.deepEqual(parseSaved('x'), { state: {}, unkeyed: undefined });
    const { state } = parseSaved({ last: 3, repos: [['/w/a', {}], 'junk', [1, {}]], metaOpen: 'yes' });
    assert.deepEqual(state, { repos: [['/w/a', {}]] });
  });

  it('reads its own state back', () => {
    const s = remember({ metaOpen: true }, '/w/a', { selectedHash: 'aaa' });
    assert.deepEqual(parseSaved(JSON.parse(JSON.stringify(s))), { state: s, unkeyed: undefined });
  });
});
