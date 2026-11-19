import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { changeMarkers, firstChange, lineGlyphs } from '../../src/core/change-markers.ts';

const header = 'diff --git a/f b/f\nindex 1111111..2222222 100644\n--- a/f\n+++ b/f\n';

describe('changeMarkers', () => {
  it('marks modified lines on both sides', () => {
    const m = changeMarkers(`${header}@@ -3,2 +3,3 @@ fn\n-a\n-b\n+A\n+B\n+C\n`);
    assert.deepEqual(m.before, { lines: [{ kind: 'modified', start: 3, end: 4 }], gaps: [] });
    assert.deepEqual(m.after, { lines: [{ kind: 'modified', start: 3, end: 5 }], gaps: [] });
  });

  it('marks added lines after, and where they go before', () => {
    const m = changeMarkers(`${header}@@ -4,0 +5,2 @@\n+x\n+y\n`);
    assert.deepEqual(m.after, { lines: [{ kind: 'added', start: 5, end: 6 }], gaps: [] });
    assert.deepEqual(m.before, { lines: [], gaps: [{ kind: 'added', after: 4 }] });
  });

  it('marks removed lines before, and where they were after', () => {
    const m = changeMarkers(`${header}@@ -9 +8,0 @@\n-gone\n`);
    assert.deepEqual(m.before, { lines: [{ kind: 'removed', start: 9, end: 9 }], gaps: [] });
    assert.deepEqual(m.after, { lines: [], gaps: [{ kind: 'removed', after: 8 }] });
  });

  it('places a change at the top of the file above line 1', () => {
    const m = changeMarkers(`${header}@@ -0,0 +1 @@\n+first\n@@ -1,2 +1,0 @@\n-a\n-b\n`);
    assert.deepEqual(m.before, {
      lines: [{ kind: 'removed', start: 1, end: 2 }],
      gaps: [{ kind: 'added', after: 0 }],
    });
    assert.deepEqual(m.after, {
      lines: [{ kind: 'added', start: 1, end: 1 }],
      gaps: [{ kind: 'removed', after: 1 }],
    });
  });

  it('reads every hunk, ignoring lines that are not hunk headers', () => {
    const diff = `${header}@@ -1 +1 @@\n-@@ -5 +5 @@ is text\n+x\n\\ No newline at end of file\n@@ -10,0 +11 @@\n+y\n`;
    const m = changeMarkers(diff);
    assert.deepEqual(m.after.lines, [
      { kind: 'modified', start: 1, end: 1 },
      { kind: 'added', start: 11, end: 11 },
    ]);
  });

  it('has no markers for a diff without hunks', () => {
    const empty = { before: { lines: [], gaps: [] }, after: { lines: [], gaps: [] } };
    assert.deepEqual(changeMarkers(''), empty);
    assert.deepEqual(changeMarkers(`${header.split('\n')[0]}\nBinary files a/f and b/f differ\n`), empty);
  });
});

describe('firstChange', () => {
  it('is the top-most changed line or gap, a gap showing the line above it', () => {
    assert.equal(
      firstChange({ lines: [{ kind: 'added', start: 12, end: 14 }], gaps: [{ kind: 'removed', after: 7 }] }),
      7,
    );
    assert.equal(
      firstChange({ lines: [{ kind: 'modified', start: 3, end: 3 }], gaps: [{ kind: 'added', after: 9 }] }),
      3,
    );
    assert.equal(firstChange({ lines: [], gaps: [{ kind: 'removed', after: 0 }] }), 1);
    assert.equal(firstChange({ lines: [], gaps: [] }), undefined);
  });
});

describe('lineGlyphs', () => {
  it('puts a bar beside every changed line', () => {
    const g = lineGlyphs({ lines: [{ kind: 'modified', start: 2, end: 3 }], gaps: [] }, 5);
    assert.deepEqual(
      [...g],
      [
        [1, { bar: 'modified' }],
        [2, { bar: 'modified' }],
      ],
    );
  });

  it('splits a gap triangle between the lines on either side', () => {
    const g = lineGlyphs({ lines: [], gaps: [{ kind: 'removed', after: 2 }] }, 5);
    assert.deepEqual(g.get(1), { bottom: 'removed' });
    assert.deepEqual(g.get(2), { top: 'removed' });
  });

  it('gives a gap at either end of the file the half inside it', () => {
    const top = lineGlyphs({ lines: [], gaps: [{ kind: 'added', after: 0 }] }, 3);
    assert.deepEqual([...top], [[0, { top: 'added' }]]);
    const bottom = lineGlyphs({ lines: [], gaps: [{ kind: 'removed', after: 3 }] }, 3);
    assert.deepEqual([...bottom], [[2, { bottom: 'removed' }]]);
  });

  it('combines a bar and a gap on one line', () => {
    const g = lineGlyphs({ lines: [{ kind: 'removed', start: 4, end: 4 }], gaps: [{ kind: 'added', after: 4 }] }, 6);
    assert.deepEqual(g.get(3), { bar: 'removed', bottom: 'added' });
  });

  it('ignores lines past the end of the document', () => {
    const g = lineGlyphs({ lines: [{ kind: 'added', start: 3, end: 9 }], gaps: [{ kind: 'removed', after: 9 }] }, 4);
    assert.deepEqual([...g.keys()], [2, 3]);
  });
});
