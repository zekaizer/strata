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

describe('chooseColumns', () => {
  it('shows every column while the subject keeps the width it wants', () => {
    // area 786: columns 286 leave 500
    assert.deepEqual(chooseColumns(widths(850), all, WANTED), all);
  });
  it('hides the hash first, then the date, then the author', () => {
    // area 750: all leave 464; without the hash 536
    assert.deepEqual(chooseColumns(widths(814), all, WANTED), { author: true, date: true, hash: false });
    // area 650: without the hash 436; without the date 538
    assert.deepEqual(chooseColumns(widths(714), all, WANTED), { author: true, date: false, hash: false });
    // area 590: the author alone leaves 478
    assert.deepEqual(chooseColumns(widths(654), all, WANTED), { author: false, date: false, hash: false });
  });
  it('gives a row narrower than the wanted subject wholly to the subject', () => {
    assert.deepEqual(chooseColumns(widths(400), all, WANTED), { author: false, date: false, hash: false });
  });
  it('never shows a column the setting turned off', () => {
    assert.deepEqual(chooseColumns(widths(2000), { author: true, date: true, hash: false }, WANTED), {
      author: true,
      date: true,
      hash: false,
    });
    assert.deepEqual(chooseColumns(widths(2000), { author: false, date: false, hash: true }, WANTED), {
      author: false,
      date: false,
      hash: true,
    });
  });
});
