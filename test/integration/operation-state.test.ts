import * as assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StrataTestApi } from '../../src/extension.ts';
import type { GraphPanel } from '../../src/host/panel.ts';
import { strata, waitFor, workspaceRoot } from './helpers.ts';
import { gitRetry, setIdentity, snapshotRepo } from './repo-snapshot.ts';

describe('operation in progress', () => {
  let api: StrataTestApi;
  let panel: GraphPanel;
  let restore: () => Promise<void>;

  before(async () => {
    restore = await snapshotRepo();
    await setIdentity();
    api = await strata();
    panel = api.show();
    await panel.whenReady();
    await waitFor('history', async () => (await panel.probe()).done);
  });
  after(async () => {
    await restore();
    panel.dispose();
  });

  /** Commits `content` to conflict.txt on a new branch from main. */
  const branchWith = async (branch: string, content: string) => {
    await gitRetry('switch', '--quiet', '--create', branch, 'main');
    writeFileSync(join(workspaceRoot(), 'conflict.txt'), content);
    await gitRetry('add', 'conflict.txt');
    await gitRetry('commit', '--quiet', '-m', `conflict.txt: ${content}`);
  };

  it('reports a merge stopped outside Strata until it is aborted', async () => {
    await branchWith('strata-op-theirs', 'theirs\n');
    await branchWith('strata-op-ours', 'ours\n');
    await assert.rejects(gitRetry('merge', '--no-edit', 'strata-op-theirs'));
    await waitFor('merge reported', async () => {
      const op = (await panel.probe()).operation;
      return op?.kind === 'merge' && op.branch === 'strata-op-ours' && op.conflicts.join() === 'conflict.txt';
    });
    assert.equal(api.contextValue('strata.operation'), 'merge');

    await gitRetry('merge', '--abort');
    await waitFor('merge gone', async () => (await panel.probe()).operation === undefined);
    assert.equal(api.contextValue('strata.operation'), '');
  });
});
