import * as assert from 'node:assert/strict';
import { strata } from './helpers.ts';

describe('activation', () => {
  it('opens the graph panel and starts the layout worker', async () => {
    const panel = (await strata()).show();
    const ready = await panel.whenReady();
    assert.equal(ready.workerOk, true);
    panel.dispose();
  });
});
