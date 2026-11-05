import * as assert from 'node:assert/strict';
import type { GraphPanel } from '../../src/host/panel.ts';
import type { ProbeState } from '../../src/shared/protocol.ts';
import * as vscode from 'vscode';
import { git, strata, waitFor } from './helpers.ts';

describe('hidden badges', () => {
  let panel: GraphPanel;
  const label = (s: ProbeState, ref: string) => s.rowLabels[git('rev-parse', ref)] ?? '';
  const shows = (s: ProbeState, branch: string) => label(s, branch).includes(`Branch ${branch}.`);
  const until = (what: string, test: (s: ProbeState) => boolean) =>
    waitFor(what, async () => {
      const s = await panel.probe();
      return test(s) && s;
    });
  const type = (text: string) => panel.simulate({ kind: 'type', selector: '.badge-pattern', text });
  const openFilter = async () => {
    if ((await panel.probe()).badgeFilter.pattern === undefined)
      await panel.simulate({ kind: 'click', selector: '.badge-filter-button' });
  };

  async function open(): Promise<GraphPanel> {
    const p = (await strata()).show();
    await p.whenReady();
    await waitFor('history', async () => (await p.probe()).done);
    return p;
  }

  /** Removes every rule in the popover, leaving the next run a clean slate. */
  async function removeRules(): Promise<void> {
    await openFilter();
    for (let n = (await panel.probe()).badgeRules.length; n > 0; n--) {
      await panel.simulate({ kind: 'click', selector: '.popover-rule button[aria-label^="Remove"]' });
      await until('a rule removed', (p) => p.badgeRules.length < n);
    }
    await panel.simulate({ kind: 'key', key: 'Escape' });
  }

  before(async () => {
    panel = await open();
  });
  after(async () => {
    await removeRules();
    panel.dispose();
  });

  it('opens from its own toolbar button, with no rules yet', async () => {
    let s = await panel.probe();
    assert.equal(s.badgeFilter.button, 'Badges');
    assert.equal(s.badgeFilter.pattern, undefined, 'closed at first');
    await panel.simulate({ kind: 'click', selector: '.badge-filter-button' });
    s = await until('popover open', (p) => p.badgeFilter.pattern !== undefined);
    assert.deepEqual(s.badgeFilter.rules, []);
    assert.deepEqual(s.badgeFilter.refs, [], 'nothing hidden to list');
    assert.equal(s.badgeFilter.showHidden, undefined, 'nothing hidden to show');
    assert.equal(s.badgeFilter.hide, false, 'nothing typed to hide');
    assert.match(s.focused, /badge-pattern/);
  });

  it('previews what a pattern matches and hides those badges, and only them', async () => {
    let s = await panel.probe();
    assert.ok(shows(s, 'cross/x') && shows(s, 'cross/y'), 'cross badges shown at first');
    await type('cross/*');
    s = await panel.probe();
    assert.equal(s.badgeFilter.summary, 'Matches 2 branches');
    assert.deepEqual(s.badgeFilter.refs, ['cross/x', 'cross/y']);
    assert.equal(s.badgeFilter.show, false, 'nothing hidden to show');
    await panel.simulate({ kind: 'click', selector: '.badge-hide' });
    s = await until('cross badges hidden', (p) => !shows(p, 'cross/x') && !shows(p, 'cross/y'));
    assert.ok(shows(s, 'feature/search'), 'other badges stay');
    assert.match(s.rowLabels[git('rev-parse', 'main')] ?? '', /Current branch main\./);
    assert.match(label(s, 'cross/x'), /^Merge y into x\. Hidden: cross\/x\. /, 'screen readers hear hidden refs');
    assert.equal(s.badgeFilter.button, '2 hidden');
    assert.deepEqual(s.badgeFilter.rules, ['cross/*']);
    assert.deepEqual(s.badgeFilter.refs, ['cross/x (hidden)', 'cross/y (hidden)']);
    assert.equal(s.badgeFilter.summary, 'Matches 2 branches · 2 hidden');
    assert.deepEqual([s.badgeFilter.hide, s.badgeFilter.show], [false, true]);
    assert.equal(s.badgeFilter.showHidden, 'Show hidden badges (2)');
    assert.doesNotMatch(s.refFilterButton, /hidden/, 'the branch filter is about history only');
    const row = Object.entries(s.rowHashes).find(([, h]) => h === git('rev-parse', 'cross/x'))?.[0];
    if (row !== undefined) assert.equal(s.refBands[Number(row)], undefined, 'a row left without badges has no band');
  });

  it('lists the hidden badges while no pattern is typed', async () => {
    await type('');
    const s = await panel.probe();
    assert.deepEqual(s.badgeFilter.refs, ['cross/x (hidden)', 'cross/y (hidden)']);
  });

  it('hides with Enter in the pattern box, and keeps focus there', async () => {
    await type('wip*');
    await panel.simulate({ kind: 'key', key: 'Enter', target: 'focused' });
    const s = await until('wip badge hidden', (p) => !shows(p, 'wip/experiment'));
    assert.equal(s.badgeFilter.button, '3 hidden');
    assert.match(s.focused, /badge-pattern/);
  });

  it('shows a ref named without wildcards again with Show', async () => {
    await type('cross/y');
    let s = await panel.probe();
    assert.equal(s.badgeFilter.summary, 'Matches 1 branch · 1 hidden');
    await panel.simulate({ kind: 'click', selector: '.badge-show' });
    s = await until('cross/y shown again', (p) => shows(p, 'cross/y'));
    assert.ok(!shows(s, 'cross/x'), 'the rest of the pattern stays hidden');
    assert.deepEqual(s.badgeFilter.rules, ['cross/*', 'wip*', '!cross/y']);
  });

  it("toggles one ref's badge with its eye, keeping focus on it", async () => {
    await type('cross/*');
    const eye = 'button.badge-eye[data-ref="refs/heads/cross/x"]';
    await panel.simulate({ kind: 'focus', selector: eye });
    await panel.simulate({ kind: 'click', selector: eye });
    let s = await until('cross/x shown', (p) => shows(p, 'cross/x'));
    assert.deepEqual(s.badgeFilter.refs, ['cross/x', 'cross/y']);
    assert.match(s.focused, /badge-eye/);
    await panel.simulate({ kind: 'click', selector: eye });
    s = await until('cross/x hidden again', (p) => !shows(p, 'cross/x'));
    assert.deepEqual(s.badgeFilter.rules, ['cross/*', 'wip*', '!cross/y', 'cross/x']);
    assert.match(s.focused, /badge-eye/);
  });

  it('reorders rules: the last matching one decides', async () => {
    const up = '.popover-rule button[aria-label="Move cross/y up"]';
    await panel.simulate({ kind: 'click', selector: up });
    await until('moved once', (p) => p.badgeRules[1]?.pattern === 'cross/y');
    await panel.simulate({ kind: 'click', selector: up });
    const s = await until('cross/y hidden by the rule now after it', (p) => !shows(p, 'cross/y'));
    assert.deepEqual(s.badgeFilter.rules, ['!cross/y', 'cross/*', 'wip*', 'cross/x']);
    const down = '.popover-rule button[aria-label="Move cross/y down"]';
    for (let i = 1; i <= 2; i++) {
      await panel.simulate({ kind: 'click', selector: down });
      await until(`moved down ${i}`, (p) => p.badgeRules[i]?.pattern === 'cross/y');
    }
    await until('cross/y shown again', (p) => shows(p, 'cross/y'));
  });

  it('never hides the current branch', async () => {
    await type('main');
    let s = await panel.probe();
    assert.equal(s.badgeFilter.summary, 'Matches 1 branch · the current branch stays shown');
    assert.equal(s.badgeFilter.hide, false);
    await type('*');
    s = await panel.probe();
    assert.match(s.badgeFilter.summary ?? '', /the current branch stays shown$/);
    assert.ok(s.badgeFilter.refs?.includes('main'), 'listed, without an eye');
  });

  it('shows hidden badges for now with "Show hidden badges"', async () => {
    await panel.simulate({ kind: 'click', selector: 'input[data-option="showHiddenBadges"]' });
    let s = await until('all shown', (p) => shows(p, 'cross/x') && shows(p, 'wip/experiment'));
    assert.equal(s.badgeFilter.button, 'Badges');
    assert.doesNotMatch(label(s, 'cross/x'), /Hidden:/);
    await panel.simulate({ kind: 'click', selector: 'input[data-option="showHiddenBadges"]' });
    s = await until('hidden again', (p) => !shows(p, 'cross/x'));
    assert.equal(s.badgeFilter.button, '2 hidden');
    await panel.simulate({ kind: 'key', key: 'Escape' });
    s = await until('closed', (p) => p.badgeFilter.pattern === undefined);
    assert.match(s.focused, /badge-filter-button/, 'Escape hands focus back to the button');
  });

  it('keeps the rules when the graph is opened again', async () => {
    panel.dispose();
    panel = await open();
    const s = await panel.probe();
    assert.ok(!shows(s, 'cross/x') && !shows(s, 'wip/experiment'), 'still hidden');
    assert.ok(shows(s, 'cross/y'), 'the exception is kept too');
  });

  const branchMenu = (branch: string) => ({
    webview: 'strata.graph',
    webviewSection: 'branch',
    strataHash: git('rev-parse', branch),
    strataRef: `refs/heads/${branch}`,
    strataIsCurrent: false,
    strataUpstream: false,
  });

  it('hides one badge with Hide Badge', async () => {
    await vscode.commands.executeCommand('strata.hideBadge', branchMenu('cross/y'));
    const s = await until('cross/y hidden', (p) => !shows(p, 'cross/y'));
    assert.deepEqual(s.badgeRules.at(-1), { pattern: 'cross/y', keep: false });
  });

  it('opens the popover with a pattern for the badge with Hide Similar Badges, hiding on confirmation', async () => {
    await vscode.commands.executeCommand('strata.hideSimilarBadges', branchMenu('feature/login'));
    let s = await until('popover open', (p) => p.badgeFilter.pattern !== undefined);
    assert.equal(s.badgeFilter.pattern, 'feature/*');
    assert.equal(s.badgeFilter.summary, 'Matches 2 branches');
    assert.ok(shows(s, 'feature/login'), 'nothing hidden before confirming');
    await panel.simulate({ kind: 'click', selector: '.badge-hide' });
    s = await until('feature badges hidden', (p) => !shows(p, 'feature/login') && !shows(p, 'feature/search'));
    assert.deepEqual(s.badgeRules.at(-1), { pattern: 'feature/*', keep: false });
    await panel.simulate({ kind: 'key', key: 'Escape' });
  });
});
