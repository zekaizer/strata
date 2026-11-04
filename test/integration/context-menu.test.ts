import * as assert from 'node:assert/strict';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { GraphPanel } from '../../src/host/panel.ts';
import { git, strata, waitFor, workspaceRoot } from './helpers.ts';

/** What VS Code passes to a webview/context command: the element's data-vscode-context plus the webview id. */
const menuArg = (ctx: Record<string, unknown>) => ({ webview: 'strata.graph', ...ctx });

describe('context menus', () => {
  let panel: GraphPanel;
  let hash: string;
  const file = 'feature_search.txt';

  before(async () => {
    panel = (await strata()).show();
    await panel.whenReady();
    await waitFor('history', async () => (await panel.probe()).done);
    hash = git('log', '--all', '--format=%H', '--fixed-strings', '--grep=Search ranking', '-n1');
    const order = git('rev-list', '--topo-order', '--branches', '--remotes', 'HEAD').split('\n');
    await panel.simulate({ kind: 'clickRow', index: order.indexOf(hash) });
    await waitFor('details', async () => (await panel.probe()).detailsShown === hash);
  });
  after(() => {
    panel.dispose();
  });

  const fileContext = async () => {
    const ctx = (await panel.probe()).menuContexts.files[0];
    assert.ok(ctx, 'file has a menu context');
    return ctx;
  };

  it('describes a modified file for the menu', async () => {
    const ctx = await fileContext();
    assert.equal(ctx['webviewSection'], 'file');
    assert.equal(ctx['strataPath'], file);
    assert.equal(ctx['strataHash'], hash);
    assert.equal(ctx['strataHasDiff'], true);
    assert.equal(ctx['strataHasOld'], true);
    assert.equal(ctx['strataHasNew'], true);
    assert.equal(ctx['strataRenamed'], false);
  });

  it('copies the repository-relative and the absolute path', async () => {
    await vscode.commands.executeCommand('strata.file.copyRelativePath', menuArg(await fileContext()));
    assert.equal(await vscode.env.clipboard.readText(), file);
    await vscode.commands.executeCommand('strata.file.copyPath', menuArg(await fileContext()));
    assert.equal(await vscode.env.clipboard.readText(), join(workspaceRoot(), file));
  });

  it('copies the old path of a rename', async () => {
    const ctx = { ...(await fileContext()), strataStatus: 'R', strataOldPath: 'old/name.txt', strataRenamed: true };
    await vscode.commands.executeCommand('strata.file.copyOldRelativePath', menuArg(ctx));
    assert.equal(await vscode.env.clipboard.readText(), 'old/name.txt');
  });

  it('opens the old version from the menu', async () => {
    const before = vscode.window.tabGroups.activeTabGroup.activeTab;
    await vscode.commands.executeCommand('strata.file.openOld', menuArg(await fileContext()));
    const input = await waitFor('old version tab', () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      return tab !== before && tab?.input;
    });
    assert.ok(input instanceof vscode.TabInputText);
    assert.equal(
      (await vscode.workspace.openTextDocument(input.uri)).getText(),
      git('show', `${hash}^:${file}`) + '\n',
    );
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  it('copies the hash, short hash and subject of a commit row', async () => {
    const row = (await panel.probe()).menuContexts.selectedRow;
    assert.ok(row);
    assert.equal(row['webviewSection'], 'commit');
    await vscode.commands.executeCommand('strata.commit.copyHash', menuArg(row));
    assert.equal(await vscode.env.clipboard.readText(), hash);
    await vscode.commands.executeCommand('strata.commit.copyShortHash', menuArg(row));
    assert.equal(await vscode.env.clipboard.readText(), git('rev-parse', '--short', hash));
    await vscode.commands.executeCommand('strata.commit.copySubject', menuArg(row));
    assert.equal(await vscode.env.clipboard.readText(), 'Search ranking');
  });

  it('copies the relative path with Shift+Alt+C on a focused file', async () => {
    await vscode.env.clipboard.writeText('');
    await panel.simulate({ kind: 'key', key: 'C', target: 'files', shiftKey: true, altKey: true });
    await waitFor('clipboard', async () => (await vscode.env.clipboard.readText()) === file);
  });

  it('rejects menu arguments that are not a commit id and repository path', async () => {
    await vscode.env.clipboard.writeText('unchanged');
    const ctx = { ...(await fileContext()), strataPath: '../outside.txt' };
    await assert.rejects(Promise.resolve(vscode.commands.executeCommand('strata.file.copyPath', menuArg(ctx))));
    assert.equal(await vscode.env.clipboard.readText(), 'unchanged');
  });
});
