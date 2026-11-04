import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { GraphPanel } from '../../src/host/panel.ts';
import { git, strata, waitFor } from './helpers.ts';

describe('commit list polish', () => {
  let panel: GraphPanel;
  before(async () => {
    panel = (await strata()).show();
    await panel.whenReady();
    await waitFor('history', async () => (await panel.probe()).done);
  });
  after(async () => {
    panel.dispose();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  /** Narrows the graph by opening `groups` editor groups beside it. */
  async function narrow(groups: number): Promise<number> {
    for (let i = 0; i < groups; i++) {
      const doc = await vscode.workspace.openTextDocument({ content: `beside ${i}` });
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    }
    await vscode.commands.executeCommand('workbench.action.evenEditorWidths');
    let width = 0;
    await waitFor('narrower list', async () => {
      const s = await panel.probe();
      width = s.listWidth;
      return s.columns.length > 0 && width > 0 && s;
    });
    return width;
  }

  it('keeps the commit SHA visible when the editor is narrow', async () => {
    const wide = await panel.probe();
    assert.ok(wide.columns.includes('hash'), `wide: ${wide.columns.join(' ')}`);
    const medium = await narrow(1);
    const m = await panel.probe();
    assert.ok(m.columns.includes('hash'), `${medium}px: ${m.columns.join(' ')}`);
    const small = await narrow(1);
    const n = await panel.probe();
    assert.ok(small < 600, `list still ${small}px wide`);
    assert.ok(n.columns.includes('hash'), `${small}px: ${n.columns.join(' ')}`);
  });

  it('drops a stuck hover once the graph comes back after opening a file', async () => {
    // Closing the extra groups may close the graph too; start from a fresh one.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    panel = (await strata()).show();
    await panel.whenReady();
    await waitFor('history', async () => (await panel.probe()).done);
    const hash = git('log', '--all', '--format=%H', '--fixed-strings', '--grep=Search ranking', '-n1');
    const order = git('rev-list', '--topo-order', '--branches', '--remotes', 'HEAD').split('\n');
    if ((await panel.probe()).detailsShown !== hash)
      await panel.simulate({ kind: 'clickRow', index: order.indexOf(hash) });
    await waitFor('details', async () => (await panel.probe()).detailsShown === hash);
    const before = vscode.window.tabGroups.activeTabGroup.activeTab;
    await panel.simulate({ kind: 'clickFile', index: 0 });
    await waitFor('diff tab', () => vscode.window.tabGroups.activeTabGroup.activeTab !== before);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await waitFor('hover suppressed after returning', async () => (await panel.probe()).hoverSuppressed);
  });

  it('shows the full subject at the top of the details', async () => {
    const hash = git('rev-list', '--topo-order', '-n1', '--branches', '--remotes', 'HEAD');
    await panel.simulate({ kind: 'clickRow', index: 0 });
    const s = await waitFor('details', async () => {
      const p = await panel.probe();
      return p.detailsShown === hash && p;
    });
    assert.equal(s.detailsSubject, git('log', '-1', '--format=%s', hash));
  });
});
