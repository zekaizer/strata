import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RANGE_OFF_LINE, shiftClick } from '../../src/core/range-select.ts';
import { TIDY_WHOLE_HISTORY } from '../../src/core/wording.ts';

// HEAD's line is c, b, a; `merge` and `side` are beyond it.
const line = new Set(['c', 'b', 'a']);
const click = (anchor: string | undefined, target: string | undefined, pathFiltered = false) =>
  shiftClick({ anchor, target, pathFiltered, rewritable: (h) => line.has(h) });

describe('shiftClick', () => {
  it('selects the run between two commits that can be rewritten', () => {
    assert.deepEqual(click('c', 'a'), { kind: 'range', anchor: 'c', end: 'a' });
  });
  it('says which commits can be selected together when the clicked one cannot be rewritten', () => {
    assert.deepEqual(click('c', 'merge'), { kind: 'click', why: RANGE_OFF_LINE });
  });
  it('says so when the run would start at a commit that cannot be rewritten', () => {
    assert.deepEqual(click('side', 'a'), { kind: 'click', why: RANGE_OFF_LINE });
  });
  it('says so for a row that is not a commit', () => {
    assert.deepEqual(click('c', undefined), { kind: 'click', why: RANGE_OFF_LINE });
  });
  it('is a plain click with nothing selected or on the selected commit', () => {
    assert.deepEqual(click(undefined, 'a'), { kind: 'click', why: undefined });
    assert.deepEqual(click('merge', 'merge'), { kind: 'click', why: undefined });
  });
  it('asks for the whole history under a path filter, where no commit can be rewritten', () => {
    assert.deepEqual(click('c', 'a', true), { kind: 'click', why: TIDY_WHOLE_HISTORY });
  });
});
