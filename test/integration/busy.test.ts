import * as assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StrataTestApi } from '../../src/extension.ts';
import type { GraphPanel } from '../../src/host/panel.ts';
import { git, strata, waitFor, workspaceRoot } from './helpers.ts';
import { gitRetry, setIdentity, snapshotRepo } from './repo-snapshot.ts';

describe('while an operation runs', () => {
  let api: StrataTestApi;
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
    api = await strata();
    panel = api.show();
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

  it('leaves the commands that change the repository on with a git new enough to write', async () => {
    await waitFor('the git version read', () => api.contextValue('strata.readOnly') !== undefined);
    assert.equal(api.contextValue('strata.readOnly'), false);
  });

  it('does not show its own unfinished steps as an operation that stopped, even when reloaded', async () => {
    const restore = await snapshotRepo();
    await setIdentity();
    try {
      await operation('Rebasing', async () => {
        // Where a rebase Strata runs is between two commits: git's rebase state is on disk.
        git('switch', '--quiet', '--create', 'strata-busy', 'main~1');
        writeFileSync(join(workspaceRoot(), 'main.txt'), 'busy\n');
        git('commit', '--quiet', '-am', 'Busy');
        await assert.rejects(gitRetry('rebase', 'main'));
        await panel.flowHost().refresh();
        assert.equal((await panel.probe()).operation, undefined);
        assert.equal(api.contextValue('strata.operation'), '');
        git('rebase', '--abort');
      });
    } finally {
      await restore();
      await panel.flowHost().refresh();
      await waitFor('history', async () => (await panel.probe()).done);
    }
  });

  it('selects the commit an operation focused, unless the user moved the selection while it ran', async () => {
    await select(2);
    await operation('Testing', () => Promise.resolve());
    await panel.flowHost().refresh(order()[5]);
    await waitFor('focus applied', async () => (await panel.probe()).selected === order()[5]);

    await operation('Testing', () => select(7));
    await panel.flowHost().refresh(order()[5]);
    const s = await waitFor('refreshed', async () => {
      const p = await panel.probe();
      return !p.restoring && p;
    });
    assert.equal(s.selected, order()[7], "the user's choice stays");
  });
});

describe('while history loads', () => {
  let panel: GraphPanel;

  before(async () => {
    panel = (await strata()).show();
    await panel.whenReady();
    await waitFor('history', async () => (await panel.probe()).done);
  });
  after(() => {
    panel.dispose();
  });

  it('drops a page that a newer history made moot, instead of reporting it as an error', async () => {
    const refresh = () => panel.simulate({ kind: 'click', selector: '.codicon-refresh' });
    const { alerted, generation } = await panel.probe();
    let raced = false;
    // The first page of the new history is being read when the next reset comes.
    const sub = panel.onDidReceiveMessage((m) => {
      if (m.type !== 'loadMore' || raced) return;
      raced = true;
      void refresh();
    });
    try {
      await refresh();
      await waitFor('the newer history', async () => {
        const p = await panel.probe();
        return p.generation >= generation + 2 && p.done;
      });
      assert.ok(raced);
      assert.equal((await panel.probe()).alerted, alerted);
    } finally {
      sub.dispose();
    }
  });
});
