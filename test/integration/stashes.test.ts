import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { GraphPanel } from '../../src/host/panel.ts';
import type { ProbeState } from '../../src/shared/protocol.ts';
import { addBranchyStashes, storeStash } from '../fixtures/stashes.ts';
import { git, strata, waitFor, workspaceRoot } from './helpers.ts';

describe('stash rows', () => {
  let panel: GraphPanel;
  /** Stash commits, stash@{0} first. */
  let stash: string[];
  const rowOf = (p: ProbeState, hash: string) =>
    Number(Object.entries(p.rowHashes).find(([, h]) => h === hash)?.[0] ?? -1);
  const short = (rev: string) => git('rev-parse', '--short=7', rev);

  /** Waits until every row of the list is rendered, so absent hashes are really absent. */
  async function probeAll(): Promise<ProbeState> {
    return waitFor('all rows rendered', async () => {
      const p = await panel.probe();
      return p.done && Object.keys(p.rowHashes).length === p.commits + Object.keys(p.stashRows).length && p;
    });
  }

  before(async () => {
    panel = (await strata()).show();
    await panel.whenReady();
    await waitFor('history', async () => (await panel.probe()).done);
    stash = addBranchyStashes(workspaceRoot()).reverse();
    await panel.simulate({ kind: 'click', selector: '.codicon-refresh' });
    await waitFor('stash rows', async () => Object.keys((await panel.probe()).stashRows).length === 4);
  });
  after(() => {
    git('stash', 'clear');
    panel.dispose();
  });

  it('draws each stash directly above the commit it was made on, stash@{0} topmost', async () => {
    const p = await probeAll();
    assert.equal(rowOf(p, stash[1]!), 0, 'WIP on main is the first row');
    assert.equal(rowOf(p, git('rev-parse', 'HEAD')), 1);
    assert.equal(rowOf(p, stash[3]!), rowOf(p, stash[2]!) + 1);
    assert.equal(rowOf(p, git('rev-parse', 'feature/search')), rowOf(p, stash[3]!) + 1);
  });

  it("draws a stash whose base left its branch above the branch's tip, and leaves out one on no branch", async () => {
    const p = await probeAll();
    assert.equal(rowOf(p, git('rev-parse', 'wip/experiment')), rowOf(p, stash[0]!) + 1);
    const row = p.stashRows[rowOf(p, stash[0]!)]!;
    assert.equal(row.autostash, true);
    assert.match(row.text, new RegExp(`based on ${short('stash@{0}^')}, no longer on 'wip/experiment'$`));
    assert.equal(rowOf(p, stash[4]!), -1);
  });

  it('labels a stash row for screen readers and menus, in one line', async () => {
    const p = await probeAll();
    const i = rowOf(p, stash[2]!);
    const row = p.stashRows[i]!;
    assert.equal(row.badge, 'stash@{2}');
    assert.equal(row.text, 'stash@{2}On feature/search: half-done ranking UI');
    assert.ok(
      row.label.startsWith(
        `Stash stash@{2}: On feature/search: half-done ranking UI. Based on ${short('feature/search')} ` +
          '"Search ranking". 2 files changed, 1 untracked. Stashed ',
      ),
      row.label,
    );
    assert.deepEqual(row.context, {
      webviewSection: 'stash',
      preventDefaultContextMenuItems: true,
      strataHash: stash[2],
      strataSubject: 'On feature/search: half-done ranking UI',
    });
    assert.equal(p.rowHeights[i], 24);
  });

  it('moves through stash rows with the arrow keys, and their details follow', async () => {
    const head = git('rev-parse', 'HEAD');
    await panel.simulate({ kind: 'clickRow', index: 1 });
    await waitFor('HEAD details', async () => (await panel.probe()).detailsShown === head);
    await panel.simulate({ kind: 'key', key: 'ArrowUp' });
    await waitFor('stash details', async () => (await panel.probe()).detailsShown === stash[1]);
    await panel.simulate({ kind: 'key', key: 'ArrowDown' });
    await waitFor('HEAD again', async () => (await panel.probe()).selected === head);
    await panel.simulate({ kind: 'key', key: 'Escape' });
  });

  it("shows a stash's base, staged count, changes and untracked files in its details", async () => {
    const p = await probeAll();
    await panel.simulate({ kind: 'clickRow', index: rowOf(p, stash[2]!) });
    const d = await waitFor('stash details', async () => {
      const s = await panel.probe();
      return s.detailsShown === stash[2] && s.details && s;
    });
    assert.ok(d.details!.byline.startsWith('stash@{2}·stashed '), d.details!.byline);
    assert.ok(d.details!.byline.includes(`·on feature/search·${short(stash[2]!)}`), d.details!.byline);
    assert.equal(d.detailsSubject, 'half-done ranking UI');
    assert.equal(d.details!.filesSummary, `Changes (2) · vs ${short('feature/search')}`);
    assert.deepEqual(d.fileTree, ['src/', '  ranking.ts', 'feature_search.txt', 'notes/', '  ranking-ideas.md']);
    assert.deepEqual(d.fileViews, [
      { path: 'ranking.ts', views: ['after'] },
      { path: 'feature_search.txt', views: ['diff', 'before', 'after'] },
      { path: 'ranking-ideas.md', views: ['after'] },
    ]);
    const untracked = d.menuContexts.files[2]!;
    assert.equal(untracked['strataHash'], git('rev-parse', 'stash@{2}^3'));
    assert.equal(untracked['strataBase'], undefined);

    await panel.simulate({ kind: 'click', selector: '.byline-toggle' });
    const meta = await waitFor('meta open', async () => {
      const s = await panel.probe();
      return s.details?.metaOpen && s.details;
    });
    assert.deepEqual(meta.metaRows, ['Stash', 'Base', 'Staged']);
    await panel.simulate({ kind: 'click', selector: '.byline-toggle' });

    const before = vscode.window.tabGroups.activeTabGroup.activeTab;
    await panel.simulate({ kind: 'clickFile', index: 2 });
    const input = await waitFor('untracked file tab', () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      return tab !== before && tab?.input;
    });
    assert.ok(input instanceof vscode.TabInputText);
    assert.equal((await vscode.workspace.openTextDocument(input.uri)).getText(), '# Ranking ideas\n');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await panel.simulate({ kind: 'key', key: 'Escape' });
  });

  it('keeps a selected stash selected across a reload', async () => {
    const p = await probeAll();
    await panel.simulate({ kind: 'clickRow', index: rowOf(p, stash[3]!) });
    await waitFor('stash selected', async () => (await panel.probe()).detailsShown === stash[3]);
    await panel.simulate({ kind: 'click', selector: '.codicon-refresh' });
    const after = await waitFor('reloaded', async () => {
      const s = await panel.probe();
      return s.generation > p.generation && s.done && s.detailsShown === stash[3] && s;
    });
    assert.equal(after.selected, stash[3]);
    await panel.simulate({ kind: 'key', key: 'Escape' });
  });

  it('adds and removes stash rows without reloading the history', async () => {
    const before = await probeAll();
    const late = storeStash(workspaceRoot(), {
      base: 'cross/x',
      branch: 'cross/x',
      message: 'late idea',
      worktree: { 'cross_x.txt': 'late\n' },
      time: 2500,
    });
    const added = await waitFor('new stash row', async () => {
      const p = await probeAll();
      return rowOf(p, late) >= 0 && p;
    });
    assert.equal(added.generation, before.generation, 'the history was not reloaded');
    assert.equal(rowOf(added, git('rev-parse', 'cross/x')), rowOf(added, late) + 1);
    assert.equal(added.stashRows[rowOf(added, stash[2]!)]!.badge, 'stash@{3}', 'older stashes are renumbered');

    git('stash', 'drop', '--quiet', 'stash@{0}');
    const dropped = await waitFor('stash row gone', async () => {
      const p = await probeAll();
      return rowOf(p, late) < 0 && p;
    });
    assert.equal(dropped.generation, before.generation);
    assert.equal(dropped.stashRows[rowOf(dropped, stash[2]!)]!.badge, 'stash@{2}');
  });
});
