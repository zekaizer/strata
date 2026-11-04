import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chooseColumns, type ColumnWidths } from '../../src/webview/columns.ts';

// Subject space = list - (graph + gap) - padding - (gap + hash) - (gap + each shown optional column).
const widths = (list: number): ColumnWidths => ({
  list,
  graph: 40,
  author: 70,
  dateFull: 140,
  dateShort: 90,
  hash: 60,
  gap: 12,
  padding: 12,
});

describe('chooseColumns', () => {
  it('shows everything when the subject keeps its room', () => {
    // 1000 - 40 - 12 - (12 + 60) - (12 + 70) - (12 + 140) - 12 = 630
    assert.deepEqual(chooseColumns(widths(1000), 300), { author: true, date: 'full' });
  });
  it('shortens the date first', () => {
    // 700: the full date leaves 330
    assert.deepEqual(chooseColumns(widths(700), 300), { author: true, date: 'full' });
    // 660: full leaves 290; short leaves 340
    assert.deepEqual(chooseColumns(widths(660), 300), { author: true, date: 'short' });
  });
  it('then drops the date, then the author', () => {
    // 600: short leaves 280; no date leaves 382
    assert.deepEqual(chooseColumns(widths(600), 300), { author: true, date: 'none' });
    // 480: no date leaves 262; no author leaves 344
    assert.deepEqual(chooseColumns(widths(480), 300), { author: false, date: 'none' });
  });
  it('keeps the least when even that leaves less', () => {
    assert.deepEqual(chooseColumns(widths(200), 300), { author: false, date: 'none' });
  });
});
