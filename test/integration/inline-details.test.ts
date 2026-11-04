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
});
