import * as assert from 'node:assert/strict';
import type { GraphPanel } from '../../src/host/panel.ts';
import { git, strata, waitFor } from './helpers.ts';

describe('while an operation runs', () => {
  let panel: GraphPanel;
  const order = () => git('rev-list', '--topo-order', '--branches', '--remotes', 'HEAD').split('\n');
  /** Runs `during` inside a Strata operation, as a flow's steps would run. */
  const operation = (label: string, during: () => Promise<void>) => {
    const host = panel.flowHost();
    return host.runner.run(host, label, false, during);
  };
  const select = async (index: number) => {
    await panel.simulate({ kind: 'clickRow', index });
    await waitFor(`row ${index} selected`, async () => (await panel.probe()).selected === order()[index]);
  };

  before(async () => {
    panel = (await strata()).show();
    await panel.whenReady();
    await waitFor('history', async () => (await panel.probe()).done);
  });
  after(() => {
    panel.dispose();
  });

  it('says in the toolbar what is running and marks the list busy, until it ends', async () => {
    await operation('Rebasing feature onto main', async () => {
      const s = await waitFor('busy', async () => {
        const p = await panel.probe();
        return p.listBusy && p;
      });
      assert.equal(s.status, 'Rebasing feature onto main…');
    });
    const s = await waitFor('idle', async () => {
      const p = await panel.probe();
      return !p.listBusy && p;
    });
    assert.equal(s.status, `${order().length} commits`);
  });

  it('selects the commit an operation focused, unless the user moved the selection while it ran', async () => {
    await select(2);
    await operation('Testing', () => Promise.resolve());
    await panel.flowHost().refresh(order()[5]);
    await waitFor('focus applied', async () => (await panel.probe()).selected === order()[5]);

    await operation('Testing', () => select(7));
    const generation = (await panel.probe()).generation;
    await panel.flowHost().refresh(order()[5]);
    const s = await waitFor('reloaded', async () => {
      const p = await panel.probe();
      return p.generation > generation && p.done && p;
    });
    assert.equal(s.selected, order()[7], "the user's choice stays");
  });
});
