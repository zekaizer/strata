import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { GraphPanel } from '../../src/host/panel.ts';
import { join } from 'node:path';
import { delay, git, strata, waitFor, workspaceRoot } from './helpers.ts';

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

  it('sizes the author column to the names, not to a fixed width', async () => {
    const s = await panel.probe();
    assert.ok(s.authorColumn.widestName > 0, 'names rendered');
    assert.ok(
      s.authorColumn.column - s.authorColumn.widestName <= 2,
      `column ${s.authorColumn.column}px for names up to ${s.authorColumn.widestName}px`,
    );
  });

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

  it('keeps every toolbar control on screen in a narrow editor with the filters on', async () => {
    for (let i = 0; i < 3 && (await panel.probe()).listWidth >= 600; i++) await narrow(1);
    await vscode.commands.executeCommand(
      'strata.showHistory',
      vscode.Uri.file(join(workspaceRoot(), 'feature_search.txt')),
    );
    await waitFor('path history', async () => (await panel.probe()).options.path !== null);
    await panel.simulate({ kind: 'click', selector: '.first-parent-button' });
    const s = await waitFor('first parent', async () => {
      const p = await panel.probe();
      return p.options.firstParent && p.done && p;
    });
    await delay(100);
    const fitted = await panel.probe();
    assert.ok(s.listWidth < 600, `list still ${s.listWidth}px wide`);
    assert.deepEqual(fitted.toolbarClipped, [], `${fitted.listWidth}px: ${fitted.buttonNames.toolbar.join(' | ')}`);
    await panel.simulate({ kind: 'click', selector: '.first-parent-button' });
    await panel.simulate({ kind: 'click', selector: '.path-chip-clear' });
    await waitFor('whole history', async () => {
      const p = await panel.probe();
      return p.options.path === null && !p.options.firstParent;
    });
  });

  it('drops a stuck hover once the graph comes back after opening a file', async () => {
    // Start from one editor group with a fresh graph: closing editors leaves the extra groups of
    // the previous test, and a diff opened in another group would not hide the graph at all.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('workbench.action.editorLayoutSingle');
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
    // Like a user reading the diff: the graph stays hidden long enough for VS Code to report it.
    await waitFor(
      'hover suppressed while the diff covers the graph',
      async () => (await panel.probe()).hoverSuppressed,
    );
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await delay(300);
    assert.equal((await panel.probe()).hoverSuppressed, true, 'still off until the pointer moves');
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
