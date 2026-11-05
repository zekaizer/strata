import * as assert from 'node:assert/strict';
import type { GraphPanel } from '../../src/host/panel.ts';
import type { ProbeState } from '../../src/shared/protocol.ts';
import { git, strata, waitFor } from './helpers.ts';

describe('current checkout row', () => {
  let panel: GraphPanel;
  const rowOf = (s: ProbeState, ref: string) =>
    Number(Object.entries(s.rowHashes).find(([, h]) => h === git('rev-parse', ref))?.[0]);
  const transparent = 'rgba(0, 0, 0, 0)';

  before(async () => {
    panel = (await strata()).show();
    await panel.whenReady();
    await waitFor('history', async () => (await panel.probe()).done);
    // Hover paints a row too; the pointer is not on the list.
    await panel.simulate({ kind: 'key', key: 'Escape' });
  });
  after(() => {
    panel.dispose();
  });

  it('tints the HEAD row and marks its left edge; other rows stay plain', async () => {
    const s = await panel.probe();
    const head = s.rowPaint[rowOf(s, 'HEAD')]!;
    const other = s.rowPaint[rowOf(s, 'feature/search')]!;
    assert.notEqual(head.background, transparent, 'HEAD row tinted');
    assert.match(head.boxShadow, /inset/, 'HEAD row has an edge bar');
    assert.deepEqual(other, { background: transparent, boxShadow: 'none' });
  });

  it('keeps the selection colours on a selected HEAD row, and its edge bar', async () => {
    const other = rowOf(await panel.probe(), 'feature/search');
    await panel.simulate({ kind: 'clickRow', index: other });
    let s = await waitFor('other row selected', async () => {
      const p = await panel.probe();
      return p.selected === git('rev-parse', 'feature/search') && p;
    });
    const selection = s.rowPaint[other]!.background;
    await panel.simulate({ kind: 'clickRow', index: rowOf(s, 'HEAD') });
    s = await waitFor('HEAD selected', async () => {
      const p = await panel.probe();
      return p.selected === git('rev-parse', 'HEAD') && p;
    });
    const head = s.rowPaint[rowOf(s, 'HEAD')]!;
    assert.equal(head.background, selection);
    assert.match(head.boxShadow, /inset/);
  });
});
