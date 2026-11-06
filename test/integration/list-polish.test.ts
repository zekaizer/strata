import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { GraphPanel } from '../../src/host/panel.ts';
import { join } from 'node:path';
import { delay, git, strata, waitFor, workspaceRoot } from './helpers.ts';

describe('commit list polish', () => {
  let panel: GraphPanel;
  /**
   * The column tests need a graph wide enough for the subject's 80 characters and every column,
   * whatever the test window's size: without the side bar, zoomed out until they all show.
   */
  async function widen(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    for (let i = 0; i < 6; i++) {
      const s = await panel.probe();
      if (['author', 'date', 'hash'].every((c) => s.columns.includes(c))) return;
      await vscode.commands.executeCommand('workbench.action.zoomOut');
      await delay(300);
    }
  }

  before(async () => {
    panel = (await strata()).show();
    await panel.whenReady();
    await waitFor('history', async () => (await panel.probe()).done);
    await widen();
  });
  after(async () => {
    panel.dispose();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('workbench.action.zoomReset');
    await vscode.commands.executeCommand('workbench.view.explorer');
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

  it('gives the subject 50 characters before the date and author, and keeps the hash longest', async () => {
    const shown = (s: { columns: string[] }) => s.columns.filter((c) => ['author', 'date', 'hash'].includes(c));
    const order = ['author date hash', 'author hash', 'hash', ''];
    const check = (s: Awaited<ReturnType<GraphPanel['probe']>>) => {
      const columns = shown(s).join(' ');
      assert.ok(order.includes(columns), `${s.listWidth}px: ${columns}`);
      if (columns.includes('author'))
        assert.ok(s.subjectCh >= 49.5, `${s.listWidth}px: subject ${s.subjectCh}ch with ${columns}`);
      else if (columns === 'hash')
        assert.ok(s.subjectCh >= 29.5, `${s.listWidth}px: subject ${s.subjectCh}ch with the hash`);
      return columns;
    };
    assert.equal(check(await panel.probe()), 'author date hash');
    await narrow(1);
    check(await panel.probe());
    const small = await narrow(1);
    assert.ok(['hash', ''].includes(check(await panel.probe())), `${small}px`);
  });

  it('shows only the columns strata.columns allows, at once', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('workbench.action.editorLayoutSingle');
    panel = (await strata()).show();
    await panel.whenReady();
    await waitFor('history', async () => (await panel.probe()).done);
    await widen();
    const config = vscode.workspace.getConfiguration('strata');
    await config.update('columns', { author: true, date: true, hash: false }, vscode.ConfigurationTarget.Global);
    try {
      const s = await waitFor('no hash', async () => {
        const p = await panel.probe();
        return !p.columns.includes('hash') && p;
      });
      assert.ok(s.columns.includes('author') && s.columns.includes('date'), s.columns.join(' '));
    } finally {
      await config.update('columns', undefined, vscode.ConfigurationTarget.Global);
    }
    await waitFor('the hash again', async () => (await panel.probe()).columns.includes('hash'));
  });

  it('keeps every toolbar control on screen in a narrow editor with the filters on', async () => {
    await vscode.commands.executeCommand('workbench.action.zoomReset');
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
