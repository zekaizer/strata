import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pageFrom, RowGeometry } from '../../src/webview/row-geometry.ts';

const rows = (...banded: boolean[]) => {
  const g = new RowGeometry(24, 16);
  for (const b of banded) g.push(b);
  return g;
};

describe('RowGeometry', () => {
  it('stacks plain rows at the row height', () => {
    const g = rows(false, false, false);
    assert.equal(g.count, 3);
    assert.deepEqual([g.top(0), g.top(1), g.top(2)], [0, 24, 48]);
    assert.equal(g.total(), 72);
  });
  it('makes rows with a ref band taller', () => {
    const g = rows(true, false, true, false);
    assert.deepEqual(
      [0, 1, 2, 3].map((i) => g.top(i)),
      [0, 40, 64, 104],
    );
    assert.deepEqual(
      [0, 1, 2, 3].map((i) => g.height(i)),
      [40, 24, 40, 24],
    );
    assert.deepEqual(
      [0, 1].map((i) => g.banded(i)),
      [true, false],
    );
    assert.equal(g.total(), 128);
    assert.equal(g.top(4), 128, 'the top of the row after the last is the total');
  });
  it('finds the row at an offset, band included', () => {
    const g = rows(true, false, true, false);
    assert.equal(g.indexAt(0), 0);
    assert.equal(g.indexAt(39.5), 0);
    assert.equal(g.indexAt(40), 1);
    assert.equal(g.indexAt(64), 2, 'the band belongs to its row');
    assert.equal(g.indexAt(103), 2);
    assert.equal(g.indexAt(127), 3);
  });
  it('clamps offsets outside the rows', () => {
    const g = rows(false, true);
    assert.equal(g.indexAt(-5), 0);
    assert.equal(g.indexAt(1000), 2, 'past the end is the count, like floor(y / height) was');
  });
  it('starts over after clear', () => {
    const g = rows(true, true);
    g.clear();
    g.push(false);
    assert.equal(g.count, 1);
    assert.equal(g.total(), 24);
  });
});

describe('pageFrom', () => {
  it('moves one screen less one row through plain rows, like the fixed-height list did', () => {
    const g = rows(...Array<boolean>(100).fill(false));
    assert.equal(pageFrom(g, 0, 480, 1), 19);
    assert.equal(pageFrom(g, 19, 480, -1), 0);
  });
  it('counts banded rows by their height', () => {
    const g = rows(...Array<boolean>(100).fill(true));
    // 12 rows of 40px fill 480px: the target and the start must fit on one screen.
    assert.equal(pageFrom(g, 0, 480, 1), 11);
    assert.equal(pageFrom(g, 11, 480, -1), 0);
    assert.ok(g.top(pageFrom(g, 20, 480, 1)) + g.height(pageFrom(g, 20, 480, 1)) - g.top(20) <= 480);
  });
  it('moves at least one row and stays in the list', () => {
    const g = rows(true, true, true);
    assert.equal(pageFrom(g, 0, 10, 1), 1);
    assert.equal(pageFrom(g, 2, 10, -1), 1);
    assert.equal(pageFrom(g, 2, 480, 1), 2);
    assert.equal(pageFrom(g, 0, 480, -1), 0);
  });
});
