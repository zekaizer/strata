import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyOrder,
  draftView,
  gapAt,
  moveInDraft,
  startReorder,
  stepInDraft,
  withLine,
} from '../../src/webview/reorder-mode.ts';
import type { ReorderFacts } from '../../src/shared/protocol.ts';

const line = ['e', 'd', 'c', 'b', 'a'];
const facts = (files: Record<string, string[]>, unpushed = 5, upstream?: string): ReorderFacts => ({
  head: 'e',
  files,
  unpushed,
  ...(upstream === undefined ? {} : { upstream }),
});

describe('the reorder mode', () => {
  it('starts with the line as it is', () => {
    const mode = startReorder('e', line);
    assert.deepEqual(mode, { head: 'e', line, order: line, touched: new Set(), facts: undefined, applying: false });
    assert.equal(draftView(mode).rewritten, 0);
    assert.deepEqual(applyOrder(mode), []);
  });

  it('moves a commit or a block to a gap', () => {
    const mode = startReorder('e', line);
    assert.deepEqual(moveInDraft(mode, 2, 2, 0)?.order, ['c', 'e', 'd', 'b', 'a']);
    assert.deepEqual(moveInDraft(mode, 0, 1, 3)?.order, ['c', 'e', 'd', 'b', 'a']);
    assert.equal(moveInDraft(mode, 2, 2, 2), undefined);
    assert.deepEqual(moveInDraft(mode, 2, 2, 0)?.line, line);
  });

  it('steps a commit or a block one row, and stops at the ends of the line', () => {
    const mode = startReorder('e', line);
    assert.deepEqual(stepInDraft(mode, 1, 1, -1)?.order, ['d', 'e', 'c', 'b', 'a']);
    assert.deepEqual(stepInDraft(mode, 1, 1, 1)?.order, ['e', 'c', 'd', 'b', 'a']);
    assert.deepEqual(stepInDraft(mode, 1, 2, 1)?.order, ['e', 'b', 'd', 'c', 'a']);
    assert.deepEqual(stepInDraft(mode, 1, 2, -1)?.order, ['d', 'c', 'e', 'b', 'a']);
    assert.equal(stepInDraft(mode, 0, 0, -1), undefined);
    assert.equal(stepInDraft(mode, 3, 4, 1), undefined);
  });

  it('extends the draft when more of the line loads, and keeps it while the line reloads', () => {
    const top = startReorder('e', ['e', 'd', 'c']);
    const drafted = moveInDraft(top, 0, 0, 2)!;
    const grown = withLine(drafted, line);
    assert.deepEqual(grown.line, line);
    assert.deepEqual(grown.order, ['d', 'e', 'c', 'b', 'a']);
    assert.equal(withLine(grown, []), grown);
    assert.equal(withLine(grown, ['e', 'd']), grown);
    assert.equal(withLine(grown, line), grown);
  });

  it('says what a draft rewrites and which commits moved', () => {
    const mode = moveInDraft(startReorder('e', line), 0, 0, 3)!;
    const view = draftView(mode);
    assert.deepEqual(mode.order, ['d', 'c', 'e', 'b', 'a']);
    assert.equal(view.rewritten, 3);
    assert.deepEqual([...view.moved], [['e', 2]]);
    assert.deepEqual(applyOrder(mode), ['d', 'c', 'e']);
    assert.equal(view.pushed, 0);
    assert.deepEqual([...view.clashing], []);
  });

  it('marks only the commits the user moved, and none once the draft is the line again', () => {
    const start = startReorder('e', line);
    const two = moveInDraft(moveInDraft(start, 0, 0, 3)!, 3, 4, 0)!;
    assert.deepEqual(two.order, ['b', 'a', 'd', 'c', 'e']);
    assert.deepEqual([...draftView(two).moved].sort(), [
      ['a', -3],
      ['b', -3],
      ['e', 4],
    ]);
    const back = stepInDraft(stepInDraft(start, 1, 1, 1)!, 2, 2, -1)!;
    assert.deepEqual(back.order, line);
    assert.deepEqual([...back.touched], []);
    assert.deepEqual([...draftView(stepInDraft(back, 0, 0, 1)!).moved], [['e', 1]]);
  });

  it('counts the rewritten commits a remote has once the facts are known', () => {
    const mode = moveInDraft(startReorder('e', line), 0, 0, 3)!;
    assert.equal(draftView({ ...mode, facts: facts({}, 1, 'origin/main') }).pushed, 2);
    assert.equal(draftView({ ...mode, facts: facts({}, 3) }).pushed, 0);
    assert.equal(draftView({ ...mode, facts: facts({}, 0) }).pushed, 3);
  });

  it('names the commits that may conflict and a file they share', () => {
    const files = { e: ['x.ts', 'y.ts', 'z.ts'], d: ['y.ts', 'x.ts'], c: ['z.ts', 'q.ts'], b: ['x.ts'] };
    const mode = { ...moveInDraft(startReorder('e', line), 0, 0, 3)!, facts: facts(files) };
    const view = draftView(mode);
    assert.deepEqual([...view.clashing].sort(), ['c', 'd', 'e']);
    assert.equal(view.clashFile, 'x.ts');
    assert.equal(view.clashFiles, 3);
    const apart = draftView({ ...mode, facts: facts({ e: ['x.ts'], d: ['y.ts'], c: ['z.ts'] }) });
    assert.deepEqual([...apart.clashing], []);
    assert.equal(apart.clashFile, undefined);
    assert.equal(apart.clashFiles, 0);
  });

  it('finds the gap under the pointer from the middles of the rows', () => {
    const mids = [11, 33, 55];
    assert.equal(gapAt(mids, 0), 0);
    assert.equal(gapAt(mids, 11), 0);
    assert.equal(gapAt(mids, 12), 1);
    assert.equal(gapAt(mids, 54), 2);
    assert.equal(gapAt(mids, 400), 3);
    assert.equal(gapAt([], 5), 0);
  });
});
