import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chooseColumns, type ColumnChoice, type ColumnWidths } from '../../src/webview/columns.ts';

// Text area = list - graph - gap - padding; each column takes gap + width. The subject wants 500 px.
const widths = (list: number): ColumnWidths => ({
  list,
  graph: 40,
  author: 100,
  date: 90,
  hash: 60,
  gap: 12,
  padding: 12,
});
const all: ColumnChoice = { author: true, date: true, hash: true };
const WANTED = 500;
/** The subject width below which the hash gives way too. */
const HASH_FLOOR = 300;

describe('chooseColumns', () => {
  it('shows every column while the subject keeps the width it wants', () => {
    // area 786: columns 286 leave 500
    assert.deepEqual(chooseColumns(widths(850), all, WANTED, HASH_FLOOR), all);
  });
  it('hides the date first, then the author, and keeps the hash', () => {
    // area 750: all leave 464; without the date 566
    assert.deepEqual(chooseColumns(widths(814), all, WANTED, HASH_FLOOR), { author: true, date: false, hash: true });
    // area 650: without the date 466; without the author too 578
    assert.deepEqual(chooseColumns(widths(714), all, WANTED, HASH_FLOOR), { author: false, date: false, hash: true });
    // area 386: the hash alone leaves 314, above the floor
    assert.deepEqual(chooseColumns(widths(450), all, WANTED, HASH_FLOOR), { author: false, date: false, hash: true });
  });
  it('hides the hash only once the subject would be narrower than the floor', () => {
    // area 336: the hash alone leaves 264
    assert.deepEqual(chooseColumns(widths(400), all, WANTED, HASH_FLOOR), { author: false, date: false, hash: false });
  });
  it('never shows a column the setting turned off', () => {
    assert.deepEqual(chooseColumns(widths(2000), { author: true, date: true, hash: false }, WANTED, HASH_FLOOR), {
      author: true,
      date: true,
      hash: false,
    });
    assert.deepEqual(chooseColumns(widths(2000), { author: false, date: false, hash: true }, WANTED, HASH_FLOOR), {
      author: false,
      date: false,
      hash: true,
    });
  });
});
