import * as assert from 'node:assert/strict';
import type { GraphPanel } from '../../src/host/panel.ts';
import type { ProbeState } from '../../src/shared/protocol.ts';
import { delay, git, strata, waitFor } from './helpers.ts';
import { gitRetry, snapshotRepo } from './repo-snapshot.ts';

describe('ref card on graph nodes', () => {
  let panel: GraphPanel;
  let restore: () => Promise<void>;
  const until = (what: string, test: (s: ProbeState) => boolean) =>
    waitFor(what, async () => {
      const s = await panel.probe();
      return test(s) && s;
    });
  const rowOf = (s: ProbeState, hash: string) => {
    const row = Object.entries(s.rowHashes).find(([, h]) => h === hash)?.[0];
    assert.ok(row !== undefined, `row of ${hash} rendered`);
    return Number(row);
  };

  before(async () => {
    restore = await snapshotRepo();
    await gitRetry('tag', 'strata-v1', 'cross/x');
    await gitRetry('tag', 'strata-v1-rc1', 'cross/x');
    await gitRetry('tag', 'strata-main-rc1', 'main');
    panel = (await strata()).show();
    await panel.whenReady();
    await panel.simulate({ kind: 'click', selector: '.codicon-refresh' });
    await until(
      'history with the tags',
      (s) => s.done && Object.values(s.rowLabels).some((l) => l.includes('strata-v1-rc1')),
    );
    await panel.simulate({ kind: 'click', selector: '.badge-filter-button' });
    await panel.simulate({ kind: 'type', selector: '.badge-pattern', text: '*-rc*' });
    await panel.simulate({ kind: 'click', selector: '.badge-hide' });
    await until('rule applied', (s) => s.badgeRules.length === 1);
    await panel.simulate({ kind: 'key', key: 'Escape' });
  });
  after(async () => {
    await panel.simulate({ kind: 'click', selector: '.badge-filter-button' });
    await panel.simulate({ kind: 'click', selector: '.popover-rule button[aria-label^="Remove"]' });
    await until('rule removed', (s) => s.badgeRules.length === 0);
    await panel.simulate({ kind: 'key', key: 'Escape' });
    await restore();
    panel.dispose();
  });

  it("lists every ref of the node's commit, those whose badges are hidden marked with their rule", async () => {
    const x = git('rev-parse', 'cross/x');
    const row = rowOf(await panel.probe(), x);
    await panel.simulate({ kind: 'hoverNode', index: row });
    const s = await until('card shown', (p) => p.refCard !== undefined);
    assert.equal(s.refCard!.hash, x);
    assert.deepEqual(s.refCard!.lines, ['cross/x', 'strata-v1', 'strata-v1-rc1 · hidden by *-rc*']);
  });

  it('closes when the pointer leaves the node', async () => {
    const row = rowOf(await panel.probe(), git('rev-parse', 'cross/x'));
    await panel.simulate({ kind: 'hoverNode', index: row, dx: 200 });
    await until('card gone', (p) => p.refCard === undefined);
  });

  it('marks the current branch', async () => {
    let s = await panel.probe();
    await panel.simulate({ kind: 'hoverNode', index: rowOf(s, git('rev-parse', 'main')) });
    s = await until('card shown', (p) => p.refCard !== undefined);
    assert.deepEqual(s.refCard!.lines, ['main · current branch', 'strata-main-rc1 · hidden by *-rc*']);
  });

  it('shows no card for a commit whose badges show all its refs, nor for one without refs', async () => {
    const s = await panel.probe();
    for (const at of ['feature/search', 'main~1']) {
      await panel.simulate({ kind: 'hoverNode', index: rowOf(s, git('rev-parse', at)) });
      await delay(600);
      assert.equal((await panel.probe()).refCard, undefined, at);
    }
  });

  it('closes when hover highlights go off, as when keys move the selection', async () => {
    const s = await panel.probe();
    await panel.simulate({ kind: 'hoverNode', index: rowOf(s, git('rev-parse', 'cross/x')) });
    await until('card shown', (p) => p.refCard !== undefined);
    await panel.simulate({ kind: 'key', key: 'ArrowDown' });
    await until('card gone', (p) => p.refCard === undefined);
  });
});
