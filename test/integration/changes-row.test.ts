import * as assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import * as vscode from 'vscode';
import { join } from 'node:path';
import type { GraphPanel } from '../../src/host/panel.ts';
import type { ProbeState } from '../../src/shared/protocol.ts';
import { getGitApi } from '../../src/host/git-api.ts';
import { delay, git, strata, waitFor, workspaceRoot } from './helpers.ts';

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
    assert.equal(p.rowLabels['changes'], 'Uncommitted changes on main: 1 changed.');
    git('checkout', '--', 'main.txt');
    await waitFor('no changes row', async () => rowOf(await panel.probe(), 'changes') < 0);
  });

  it('leaves a hidden graph alone and reads the changes once it is shown again', async () => {
    const api = await strata();
    const doc = await vscode.workspace.openTextDocument(file('main.txt'));
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: false });
    const graphShown = () => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputWebview;
    assert.ok(!graphShown());
    const repo = (await getGitApi()).repositories[0]!;
    const seen = new Promise<void>((resolve) => {
      const sub = repo.state.onDidChange(() => {
        sub.dispose();
        resolve();
      });
    });
    writeFileSync(file('main.txt'), 'edited while hidden\n');
    await seen;
    // Past the graph's refresh debounce: a visible graph would have its row by now.
    await delay(1500);
    assert.equal(rowOf(await panel.probe(), 'changes'), -1);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    api.show();
    await waitFor('changes row', async () => rowOf(await panel.probe(), 'changes') === 0);
    git('checkout', '--', 'main.txt');
    await waitFor('no changes row', async () => rowOf(await panel.probe(), 'changes') < 0);
  });

  it('shows a row for untracked files alone', async () => {
    writeFileSync(file('scratch.txt'), 'new\n');
    const p = await waitFor('changes row', async () => {
      const s = await panel.probe();
      return rowOf(s, 'changes') === 0 && s;
    });
    assert.equal(p.rowLabels['changes'], 'Uncommitted changes on main: 1 untracked.');
    rmSync(file('scratch.txt'));
    await waitFor('no changes row', async () => rowOf(await panel.probe(), 'changes') < 0);
  });

  it('unfolds into the changes by group, and opens a staged file as HEAD against the index', async () => {
    writeFileSync(file('NOTES.md'), 'staged\n');
    git('add', 'NOTES.md');
    writeFileSync(file('main.txt'), 'edited\n');
    writeFileSync(file('scratch.txt'), 'new\n');
    await waitFor('changes row', async () => (await panel.probe()).rowLabels['changes']?.includes('1 untracked'));
    await panel.simulate({ kind: 'clickRow', index: 0 });
    const p = await waitFor('changes unfolded', async () => {
      const s = await panel.probe();
      return s.detailsShown === 'changes' && s.fileTree.length > 0 && s;
    });
    assert.deepEqual(p.fileTree, ['NOTES.md', 'main.txt', 'scratch.txt']);
    assert.deepEqual(p.buttonNames.details.slice(0, 3), [
      'Open Source Control',
      'Stash Changes...',
      'Stash Changes (Include Untracked)...',
    ]);
    const before = vscode.window.tabGroups.activeTabGroup.activeTab;
    await panel.simulate({ kind: 'clickFile', index: 0 });
    const tab = await waitFor('diff tab', () => {
      const t = vscode.window.tabGroups.activeTabGroup.activeTab;
      return t !== before && t;
    });
    assert.ok(tab.input instanceof vscode.TabInputTextDiff);
    assert.equal(tab.label, 'NOTES.md (Index)');
    assert.equal(tab.input.original.scheme, 'git');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });
});
