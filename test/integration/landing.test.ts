import * as assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { GraphPanel } from '../../src/host/panel.ts';
import { git, strata, waitFor, workspaceRoot } from './helpers.ts';
import { gitRetry, setIdentity, snapshotRepo } from './repo-snapshot.ts';

describe('after an operation', () => {
  let panel: GraphPanel;
  let restore: () => Promise<void>;
  /** Runs `change` as a Strata operation, then reloads the graph at `focus`, as flows do. */
  const operation = async (change: () => Promise<unknown>, focus: () => string) => {
    const host = panel.flowHost();
    await host.runner.run(host, 'Testing', false, change);
    await host.refresh(focus());
  };
  const landed = (what: (refs: string) => boolean) =>
    waitFor('marked', async () => (await panel.probe()).landed.find((l) => what(l.refs)));

  before(async () => {
    restore = await snapshotRepo();
    await setIdentity();
    panel = (await strata()).show();
    await panel.whenReady();
    await waitFor('history', async () => (await panel.probe()).done);
  });
  after(async () => {
    await vscode.workspace.getConfiguration('workbench').update('reduceMotion', undefined, true);
    await restore();
    panel.dispose();
  });

  it('pulses the badge of the branch it moved, then stops', async () => {
    const target = git('rev-parse', 'feature/login~1');
    await operation(
      () => gitRetry('branch', '--force', 'feature/login', target),
      () => target,
    );
    const mark = await landed((refs) => refs.split(' ').includes('refs/heads/feature/login'));
    assert.equal(mark.animation, 'landed-badge');
    assert.ok(!(await panel.probe()).landed.some((l) => l.refs.includes('refs/heads/main')), 'main did not move');
    await waitFor('pulse over', async () => (await panel.probe()).landed.length === 0, 5000);
  });

  it('pulses what an operation that focuses nothing moved, as a fetch moves remote-tracking branches', async () => {
    await gitRetry('remote', 'add', 'origin', 'https://example.invalid/branchy.git');
    const host = panel.flowHost();
    const target = git('rev-parse', 'main~1');
    await host.runner.run(host, 'Fetching', false, () => gitRetry('update-ref', 'refs/remotes/origin/main', target));
    await host.refresh();
    const mark = await landed((refs) => refs.split(' ').includes('refs/remotes/origin/main'));
    assert.equal(mark.animation, 'landed-badge');
  });

  it('outlines the stash row it made instead, under reduced motion', async () => {
    await vscode.workspace.getConfiguration('workbench').update('reduceMotion', 'on', true);
    appendFileSync(join(workspaceRoot(), 'main.txt'), 'stashed\n');
    await operation(
      () => gitRetry('stash', 'push', '--quiet', '-m', 'landing'),
      () => git('rev-parse', 'stash@{0}'),
    );
    const stash = git('rev-parse', 'stash@{0}');
    const mark = await landed((refs) => refs === `stash:${stash}`);
    assert.equal(mark.animation, 'none');
    assert.equal(mark.outline, 'solid');
  });
});
