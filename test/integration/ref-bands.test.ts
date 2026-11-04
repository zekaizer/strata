import * as assert from 'node:assert/strict';
import type { GraphPanel } from '../../src/host/panel.ts';
import { git, strata, waitFor } from './helpers.ts';

const ROW_HEIGHT = 24;
const order = () => git('rev-list', '--topo-order', '--branches', '--remotes', 'HEAD').split('\n');

describe('ref badges', () => {
  let panel: GraphPanel;
  before(async () => {
    panel = (await strata()).show();
    await panel.whenReady();
    await waitFor('history', async () => (await panel.probe()).done);
  });
  after(() => {
    panel.dispose();
  });

  it('shows badges in a band above the subject, only on rows with refs', async () => {
    const s = await panel.probe();
    const banded = Object.keys(s.refBands).map(Number);
    assert.ok(banded.includes(0), 'the HEAD commit carries main');
    assert.ok(s.refBands[0]!.badges.includes('main'));
    for (const [i, band] of Object.entries(s.refBands)) {
      assert.ok(band.bandBottom > 0 && band.bandBottom <= band.subjectTop + 1, `row ${i}: band above the subject`);
      assert.ok(Math.abs(band.bandLeft - band.subjectLeft) <= 1, `row ${i}: band starts at the subject column`);
      assert.ok(s.rowHeights[Number(i)]! > ROW_HEIGHT, `row ${i}: taller than a plain row`);
    }
    const plain = Object.keys(s.rowHeights)
      .map(Number)
      .filter((i) => !banded.includes(i));
    assert.ok(plain.length > 0);
    for (const i of plain) assert.equal(s.rowHeights[i], ROW_HEIGHT, `row ${i}: plain rows keep their height`);
  });

  it('stacks rows by their own heights', async () => {
    const s = await panel.probe();
    for (let i = 0; s.rowTops[i + 1] !== undefined; i++) {
      assert.equal(s.rowTops[i + 1], s.rowTops[i]! + s.rowHeights[i]!, `row ${i + 1}`);
    }
  });

  it('selects a row when its band is clicked', async () => {
    const s = await panel.probe();
    const index = Object.keys(s.refBands)
      .map(Number)
      .find((i) => i > 0)!;
    await panel.simulate({ kind: 'clickRow', index, y: 2 });
    await waitFor('band click selects its row', async () => (await panel.probe()).selected === order()[index]);
  });
});
