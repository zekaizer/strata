import * as assert from 'node:assert/strict';
import type { GraphPanel } from '../../src/host/panel.ts';
import type { ProbeState } from '../../src/shared/protocol.ts';
import { delay, git, strata, waitFor } from './helpers.ts';

describe('hidden badges', () => {
  let panel: GraphPanel;
  const label = (s: ProbeState, ref: string) => s.rowLabels[git('rev-parse', ref)] ?? '';
  const shows = (s: ProbeState, branch: string) => label(s, branch).includes(`Branch ${branch}.`);
  const until = (what: string, test: (s: ProbeState) => boolean) =>
    waitFor(what, async () => {
      const s = await panel.probe();
      return test(s) && s;
    });

  async function open(): Promise<GraphPanel> {
    const p = (await strata()).show();
    await p.whenReady();
    await waitFor('history', async () => (await p.probe()).done);
    return p;
  }

  /** Removes the tests' three rules through the Hidden badges section, leaving the next run a clean slate. */
  async function removeRules(): Promise<void> {
    await panel.simulate({ kind: 'click', selector: '.ref-filter-button' });
    for (let i = 0; i < 3; i++) {
      await panel.simulate({ kind: 'click', selector: '.popover-rule button[aria-label^="Remove"]' });
      await delay(300);
    }
    await until('every badge shown', (p) => shows(p, 'cross/x') && !p.refFilterButton.includes('hidden'));
    await panel.simulate({ kind: 'key', key: 'Escape' });
  }

  before(async () => {
    panel = await open();
  });
  after(async () => {
    await removeRules();
    panel.dispose();
  });

  it('hides the badges a glob in the filter matches, and only them', async () => {
    let s = await panel.probe();
    assert.ok(shows(s, 'cross/x') && shows(s, 'cross/y'), 'cross badges shown at first');
    await panel.simulate({ kind: 'click', selector: '.ref-filter-button' });
    await panel.simulate({ kind: 'type', selector: '.popover-search', text: 'cross/*' });
    await panel.simulate({ kind: 'click', selector: '.popover-hide' });
    s = await until('cross badges hidden', (p) => !shows(p, 'cross/x') && !shows(p, 'cross/y'));
    assert.ok(shows(s, 'feature/search'), 'other badges stay');
    assert.match(s.rowLabels[git('rev-parse', 'main')] ?? '', /Current branch main\./);
    assert.match(s.refFilterButton, /2 hidden/);
    const row = Object.entries(s.rowHashes).find(([, h]) => h === git('rev-parse', 'cross/x'))?.[0];
    if (row !== undefined) assert.equal(s.refBands[Number(row)], undefined, 'a row left without badges has no band');
  });

  it('hides with Enter in the search box, and keeps focus there', async () => {
    await panel.simulate({ kind: 'type', selector: '.popover-search', text: 'wip*' });
    await panel.simulate({ kind: 'key', key: 'Enter', target: 'focused' });
    const s = await until('wip badge hidden', (p) => !shows(p, 'wip/experiment'));
    assert.match(s.refFilterButton, /3 hidden/);
    assert.match(s.focused, /popover-search/);
  });

  it('shows one ref again with its eye toggle, keeping focus on it', async () => {
    await panel.simulate({ kind: 'type', selector: '.popover-search', text: '' });
    const eye = 'button.popover-eye[data-ref="refs/heads/cross/y"]';
    await panel.simulate({ kind: 'focus', selector: eye });
    await panel.simulate({ kind: 'click', selector: eye });
    const s = await until('cross/y shown again', (p) => shows(p, 'cross/y'));
    assert.ok(!shows(s, 'cross/x'), 'the rest of the pattern stays hidden');
    assert.match(s.focused, /popover-eye/);
  });

  it('shows hidden badges for now with "Show hidden badges"', async () => {
    await panel.simulate({ kind: 'click', selector: 'input[data-option="showHiddenBadges"]' });
    let s = await until('all shown', (p) => shows(p, 'cross/x') && shows(p, 'wip/experiment'));
    assert.doesNotMatch(s.refFilterButton, /hidden/);
    await panel.simulate({ kind: 'click', selector: 'input[data-option="showHiddenBadges"]' });
    s = await until('hidden again', (p) => !shows(p, 'cross/x'));
    assert.match(s.refFilterButton, /2 hidden/);
    await panel.simulate({ kind: 'key', key: 'Escape' });
  });

  it('keeps the rules when the graph is opened again', async () => {
    panel.dispose();
    panel = await open();
    const s = await panel.probe();
    assert.ok(!shows(s, 'cross/x') && !shows(s, 'wip/experiment'), 'still hidden');
    assert.ok(shows(s, 'cross/y'), 'the exception is kept too');
  });
});
