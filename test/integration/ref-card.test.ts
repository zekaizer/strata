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
  /** The card once git answered: no line still waiting ("…"). */
  const answered = (what: string) =>
    until(what, (p) => p.refCard !== undefined && !p.refCard.lines.some((l) => l.endsWith('…')));
  const rowOf = (s: ProbeState, hash: string) => {
    const row = Object.entries(s.rowHashes).find(([, h]) => h === hash)?.[0];
    assert.ok(row !== undefined, `row of ${hash} rendered`);
    return Number(row);
  };

  before(async () => {
    restore = await snapshotRepo();
    await gitRetry('tag', 'strata-v0', 'cross/x^1^');
    await gitRetry('tag', 'strata-v1', 'cross/x');
    await gitRetry('tag', 'strata-v1-rc1', 'cross/x');
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
    const s = await answered('card answered');
    assert.equal(s.refCard!.hash, x);
    // Tagged itself: no First in, which would repeat its tag; After names the tag before its own.
    assert.deepEqual(s.refCard!.lines, [
      'cross/x',
      'strata-v1',
      'strata-v1-rc1 · hidden by *-rc*',
      'On: main · cross/x',
      'After: strata-v0 · +3 commits',
    ]);
  });

  it('says where a commit without refs is, naming no tag a rule hides', async () => {
    const s = await panel.probe();
    await panel.simulate({ kind: 'hoverNode', index: rowOf(s, git('rev-parse', 'cross/x^1')) });
    assert.deepEqual((await answered('card answered')).refCard!.lines, [
      'On: main · cross/x · cross/y',
      'First in: strata-v1',
      'After: strata-v0 · +1 commit',
    ]);
  });

  it('says when no tag has the commit yet', async () => {
    const s = await panel.probe();
    await panel.simulate({ kind: 'hoverNode', index: rowOf(s, git('rev-parse', 'main~1')) });
    const lines = (await answered('card answered')).refCard!.lines;
    assert.deepEqual(lines.slice(0, 2), ['On: main', 'First in: no tag yet']);
    assert.match(lines[2]!, /^After: strata-v1 · \+\d+ commits$/);
  });

  it('leaves out each line whose git query runs out of time', async () => {
    const api = await strata();
    // No time at all: every query is over its budget.
    api.setWhereBudget(0);
    try {
      // Commits not asked about before: the card keeps answers until the history reloads.
      let s = await panel.probe();
      await panel.simulate({ kind: 'hoverNode', index: rowOf(s, git('rev-parse', 'cross/y')) });
      s = await answered('card answered');
      assert.deepEqual(s.refCard!.lines, ['cross/y']);
      // Without refs, nothing is left to show once git is stopped.
      const hash = git('rev-parse', 'main~2');
      let asked = false;
      const listening = panel.onDidReceiveMessage((m) => {
        if (m.type === 'whereIs' && m.hash === hash) asked = true;
      });
      try {
        await panel.simulate({ kind: 'hoverNode', index: rowOf(s, hash) });
        await waitFor('card shown and asking', () => asked);
        await delay(500);
        assert.equal((await panel.probe()).refCard, undefined);
      } finally {
        listening.dispose();
      }
    } finally {
      api.setWhereBudget(undefined);
    }
  });

  it('closes when the pointer leaves the node', async () => {
    const row = rowOf(await panel.probe(), git('rev-parse', 'cross/x'));
    await panel.simulate({ kind: 'hoverNode', index: row, dx: 200 });
    await until('card gone', (p) => p.refCard === undefined);
  });

  it('marks the current branch', async () => {
    const s = await panel.probe();
    await panel.simulate({ kind: 'hoverNode', index: rowOf(s, git('rev-parse', 'main')) });
    assert.equal((await answered('card answered')).refCard!.lines[0], 'main · current branch');
  });

  it('closes when hover highlights go off, as when keys move the selection', async () => {
    const s = await panel.probe();
    await panel.simulate({ kind: 'hoverNode', index: rowOf(s, git('rev-parse', 'cross/x')) });
    await until('card shown', (p) => p.refCard !== undefined);
    await panel.simulate({ kind: 'key', key: 'ArrowDown' });
    await until('card gone', (p) => p.refCard === undefined);
  });
});
