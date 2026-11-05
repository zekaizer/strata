import * as assert from 'node:assert/strict';
import type { StrataTestApi } from '../../src/extension.ts';
import type { GraphPanel } from '../../src/host/panel.ts';
import { branchMenu, reload, run } from './flow-helpers.ts';
import { git, strata, waitFor } from './helpers.ts';
import { setIdentity, snapshotRepo } from './repo-snapshot.ts';
import { ScriptedUi } from './scripted-ui.ts';

describe('a closed graph', () => {
  const ui = new ScriptedUi();
  let api: StrataTestApi;
  let restore: () => Promise<void>;
  const open = async (): Promise<GraphPanel> => {
    const panel = api.show();
    await panel.whenReady();
    await waitFor('history', async () => (await panel.probe()).done);
    return panel;
  };
  /** A branch one commit ahead of `from`, fast-forwarded into main from the graph. */
  const fastForward = async (panel: GraphPanel, name: string, from: string) => {
    const tip = git('commit-tree', `${from}^{tree}`, '-p', from, '-m', name);
    git('branch', name, tip);
    await reload(panel);
    ui.press('Fast-Forward');
    await run('strata.merge', branchMenu(name, tip));
    assert.equal(git('rev-parse', 'main'), tip);
    return tip;
  };

  before(async () => {
    restore = await snapshotRepo();
    await setIdentity();
    api = await strata();
    api.setUi(ui);
  });
  after(async () => {
    api.setUi(undefined);
    await restore();
    api.current()?.dispose();
  });

  it("drops its Undo: the toast left open says so, and the new graph's Undo stays", async () => {
    const first = await open();
    const toast = ui.later();
    const one = await fastForward(first, 'strata-one', 'main');
    const undoOne = await toast;
    first.dispose();

    const second = await open();
    const two = await fastForward(second, 'strata-two', one);
    assert.equal(api.contextValue('strata.canUndo'), true);

    ui.clear();
    ui.press('Undo Anyway');
    await undoOne('Undo');
    assert.deepEqual(ui.asked, [
      { kind: 'notify', level: 'info', message: 'Undo is no longer available: a newer operation ran.', actions: [] },
    ]);
    assert.equal(git('rev-parse', 'main'), two);
    assert.equal(api.contextValue('strata.canUndo'), true);
  });
});
