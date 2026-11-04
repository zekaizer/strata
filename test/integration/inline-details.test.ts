import * as assert from 'node:assert/strict';
import type { GraphPanel } from '../../src/host/panel.ts';
import type { ProbeState } from '../../src/shared/protocol.ts';
import { git, strata, waitFor } from './helpers.ts';

const ROW_HEIGHT = 24;
const order = () => git('rev-list', '--topo-order', '--branches', '--remotes', 'HEAD').split('\n');

describe('inline details', () => {
  let panel: GraphPanel;
  before(async () => {
    panel = (await strata()).show();
    await panel.whenReady();
    await waitFor('history', async () => (await panel.probe()).done);
  });
  after(() => {
    panel.dispose();
  });

  async function expandedAt(index: number): Promise<ProbeState> {
    const hash = order()[index];
    return waitFor(`details expanded under row ${index}`, async () => {
      const s = await panel.probe();
      return s.detailsShown === hash && s.expandedHeight > 0 && s.rowTops[index + 1] !== undefined && s;
    });
  }

  it('opens the details between the clicked row and the next one', async () => {
    await panel.simulate({ kind: 'clickRow', index: 2 });
    const s = await expandedAt(2);
    assert.equal(s.rowTops[2], 2 * ROW_HEIGHT, 'rows above stay in place');
    assert.equal(s.rowTops[3], 3 * ROW_HEIGHT + s.expandedHeight, 'rows below move down by the details height');
  });

  it('reports rows where they are right after a fold, without waiting for a frame', async () => {
    // The previous test left row 2 expanded; clicking it again would fold it.
    if ((await panel.probe()).expandedHeight === 0) await panel.simulate({ kind: 'clickRow', index: 2 });
    await expandedAt(2);
    for (let i = 0; i < 5; i++) {
      await panel.simulate({ kind: 'key', key: 'Escape' });
      const folded = await panel.probe();
      assert.equal(folded.rowTops[3], 3 * ROW_HEIGHT + folded.expandedHeight, `fold ${i}`);
      await panel.simulate({ kind: 'key', key: 'Enter' });
      await expandedAt(2);
    }
  });

  it('collapses with Escape and expands again with Enter', async () => {
    await panel.simulate({ kind: 'key', key: 'Escape' });
    const closed = await waitFor('collapsed', async () => {
      const s = await panel.probe();
      return s.detailsShown === undefined && s.expandedHeight === 0 && s;
    });
    assert.equal(closed.rowTops[3], 3 * ROW_HEIGHT);
    assert.equal(closed.selected, order()[2], 'the selection stays');
    await panel.simulate({ kind: 'key', key: 'Enter' });
    await expandedAt(2);
  });

  it('moves the expanded details along with the keyboard selection', async () => {
    await panel.simulate({ kind: 'key', key: 'ArrowDown' });
    const s = await expandedAt(3);
    assert.equal(s.rowTops[3], 3 * ROW_HEIGHT);
  });

  it('collapses when the expanded row is clicked again', async () => {
    await panel.simulate({ kind: 'clickRow', index: 3 });
    await waitFor('collapsed by click', async () => (await panel.probe()).expandedHeight === 0);
  });

  it('caps the details height so the list below stays visible', async () => {
    await panel.simulate({ kind: 'clickRow', index: 1 });
    const s = await expandedAt(1);
    assert.ok(s.expandedHeight <= 0.5 * 1000, `height ${s.expandedHeight}`);
  });

  it('lets a fold during a reload win over restoring the expansion', async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      await panel.simulate({ kind: 'clickRow', index: 2 });
      await expandedAt(2);
      const before = (await panel.probe()).generation;
      await panel.simulate({ kind: 'click', selector: '.codicon-refresh' });
      // Fold as soon as the new history starts, before its pages (and the restore) arrive.
      await waitFor('reload started', async () => (await panel.probe()).generation > before, 15_000, 1);
      await panel.simulate({ kind: 'key', key: 'Escape' });
      await waitFor('reload done', async () => (await panel.probe()).done);
      // Give a wrongly pending restore time to unfold again.
      await new Promise((r) => setTimeout(r, 200));
      const settled = await panel.probe();
      assert.equal(settled.expandedHeight, 0, `attempt ${attempt}: details came back after Escape`);
      assert.equal(settled.detailsShown, undefined);
    }
  });
});
