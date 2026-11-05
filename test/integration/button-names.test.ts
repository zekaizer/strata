import * as assert from 'node:assert/strict';
import type { GraphPanel } from '../../src/host/panel.ts';
import { strata, waitFor } from './helpers.ts';

/** A codicon glyph read out as part of a name: Unicode's private use area. */
const GLYPH = /[-]/;

describe('button names', () => {
  let panel: GraphPanel;
  before(async () => {
    panel = (await strata()).show();
    await panel.whenReady();
    await waitFor('history', async () => (await panel.probe()).done);
  });
  after(() => {
    panel.dispose();
  });

  it('names every toolbar button in words, the ref filter by what it filters', async () => {
    const { toolbar } = (await panel.probe()).buttonNames;
    assert.deepEqual(toolbar, ['Go to HEAD (main)', 'Filter refs: All', 'Hidden badges', 'First parent', 'Refresh']);
  });

  it('names the buttons of the inline details in words', async () => {
    await panel.simulate({ kind: 'clickRow', index: 1 });
    const { details } = await waitFor('details', async () => {
      const names = (await panel.probe()).buttonNames;
      return names.details.length > 0 && names;
    });
    for (const name of details) assert.ok(name !== '' && !GLYPH.test(name), `"${name}" in ${JSON.stringify(details)}`);
    assert.ok(details.includes('Fold'), JSON.stringify(details));
  });
});
