import * as assert from 'node:assert/strict';
import type { GraphPanel } from '../../src/host/panel.ts';
import type { ProbeState } from '../../src/shared/protocol.ts';
import { strata, waitFor } from './helpers.ts';

/** An icon in a line with text centres on the text's capitals, whatever the font's ascent and descent. */
describe('icon alignment', () => {
  let panel: GraphPanel;

  before(async () => {
    panel = (await strata()).show();
    await panel.whenReady();
    await waitFor('history', async () => (await panel.probe()).done);
  });
  after(() => {
    panel.dispose();
  });

  const misaligned = (p: ProbeState) =>
    p.iconAlignment.icons
      .filter((i) => Math.abs(i.off) > 0.5)
      .map((i) => `${i.icon} "${i.text}" ${i.off.toFixed(2)}px`);

  it('centres the icons of the toolbar, the rows and the details on their text', async function () {
    await panel.simulate({ kind: 'clickRow', index: 1 });
    const p = await waitFor('details', async () => {
      const s = await panel.probe();
      return s.details && s;
    });
    if (!p.iconAlignment.trimmed) this.skip();
    assert.ok(p.iconAlignment.icons.length > 5, `${p.iconAlignment.icons.length} icons measured`);
    assert.deepEqual(misaligned(p), []);
  });

  it('centres the icons of a popover list on their text', async function () {
    await panel.simulate({ kind: 'click', selector: '.ref-filter-button' });
    const p = await waitFor('the ref filter', async () => {
      const s = await panel.probe();
      return s.spacing.popover.length > 0 && s;
    });
    if (!p.iconAlignment.trimmed) this.skip();
    assert.ok(
      p.iconAlignment.icons.some((i) => i.icon === 'codicon-git-branch' && i.text !== 'All'),
      'popover rows',
    );
    assert.deepEqual(misaligned(p), []);
    await panel.simulate({ kind: 'key', key: 'Escape', target: 'focused' });
  });
});
