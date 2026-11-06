import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { strata, waitFor } from './helpers.ts';

const graphTab = () =>
  vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .find((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith('strata.graph'));

describe('activation', () => {
  it('opens the graph panel and starts the layout worker', async () => {
    const panel = (await strata()).show();
    const ready = await panel.whenReady();
    assert.equal(ready.workerOk, true);
    panel.dispose();
  });

  it('names the graph tab after the repository it shows', async () => {
    const panel = (await strata()).show();
    await panel.whenReady();
    await waitFor('the title', () => graphTab()?.label === 'branchy');
    panel.dispose();
  });
});
