import * as assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphPanel } from '../../src/host/panel.ts';
import type { ProbeState } from '../../src/shared/protocol.ts';
import { git, strata, waitFor, workspaceRoot } from './helpers.ts';

describe('uncommitted changes row', () => {
  let panel: GraphPanel;
  const rowOf = (p: ProbeState, hash: string) =>
    Number(Object.entries(p.rowHashes).find(([, h]) => h === hash)?.[0] ?? -1);
  const file = (name: string) => join(workspaceRoot(), name);

  before(async () => {
    panel = (await strata()).show();
    await panel.whenReady();
    await waitFor('history', async () => (await panel.probe()).done);
  });
  after(() => {
    git('checkout', '--', '.');
    git('reset', '--quiet');
    rmSync(file('scratch.txt'), { force: true });
    panel.dispose();
  });

  it('has no row while the work tree is clean', async () => {
    const p = await panel.probe();
    assert.equal(rowOf(p, 'changes'), -1);
    assert.equal(rowOf(p, git('rev-parse', 'HEAD')), 0);
  });

  it('shows a row right above HEAD once a file changes, and drops it once the change is undone', async () => {
    writeFileSync(file('main.txt'), 'edited\n');
    const p = await waitFor('changes row', async () => {
      const s = await panel.probe();
      return rowOf(s, 'changes') >= 0 && s;
    });
    assert.equal(rowOf(p, 'changes'), 0);
    assert.equal(rowOf(p, git('rev-parse', 'HEAD')), 1);
    assert.equal(p.scrollTop, 0, 'a row added at the top is shown, not scrolled past');
    git('checkout', '--', 'main.txt');
    await waitFor('no changes row', async () => rowOf(await panel.probe(), 'changes') < 0);
  });

  it('shows a row for untracked files alone', async () => {
    writeFileSync(file('scratch.txt'), 'new\n');
    await waitFor('changes row', async () => rowOf(await panel.probe(), 'changes') === 0);
    rmSync(file('scratch.txt'));
    await waitFor('no changes row', async () => rowOf(await panel.probe(), 'changes') < 0);
  });
});
