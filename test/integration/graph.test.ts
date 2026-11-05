import * as assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { hasChangedPaths } from '../../src/git/commit-graph.ts';
import type { GraphPanel } from '../../src/host/panel.ts';
import type { FileView } from '../../src/shared/protocol.ts';
import { git, strata, waitFor, workspaceRoot } from './helpers.ts';

describe('graph panel', () => {
  let panel: GraphPanel;

  before(async () => {
    panel = (await strata()).show();
    await panel.whenReady();
  });
  after(() => {
    panel.dispose();
  });

  it('loads and lays out the whole fixture history', async () => {
    const total = Number(git('rev-list', '--count', '--branches', '--remotes', 'HEAD'));
    const state = await waitFor('history', async () => {
      const s = await panel.probe();
      return s.done && s.laidOut === s.commits && s.commits === total && s;
    });
    assert.equal(state.visibleSubjects[0], git('log', '-1', '--format=%s', 'HEAD'));
  });

  it('shows details for a clicked row', async () => {
    await panel.simulate({ kind: 'clickRow', index: 1 });
    const hash = git('rev-list', '--topo-order', '--skip=1', '-n1', '--branches', '--remotes', 'HEAD');
    const state = await waitFor('details', async () => {
      const s = await panel.probe();
      return s.detailsShown === hash && s;
    });
    assert.equal(state.selected, hash);
  });

  it('moves the selection with the keyboard', async () => {
    await panel.simulate({ kind: 'key', key: 'ArrowDown' });
    const hash = git('rev-list', '--topo-order', '--skip=2', '-n1', '--branches', '--remotes', 'HEAD');
    await waitFor('keyboard selection', async () => (await panel.probe()).detailsShown === hash);
  });

  const order = () => git('rev-list', '--topo-order', '--branches', '--remotes', 'HEAD').split('\n');

  async function selectCommit(subject: string): Promise<string> {
    const hash = git('log', '--all', '--format=%H', '--fixed-strings', `--grep=${subject}`, '-n1');
    // Clicking the row whose details are already open folds them.
    if ((await panel.probe()).detailsShown === hash) return hash;
    await panel.simulate({ kind: 'clickRow', index: order().indexOf(hash) });
    await waitFor(`details of ${subject}`, async () => (await panel.probe()).detailsShown === hash);
    return hash;
  }

  async function activeTabInput(): Promise<unknown> {
    const before = vscode.window.tabGroups.activeTabGroup.activeTab;
    await panel.simulate({ kind: 'clickFile', index: 0 });
    return waitFor('editor tab', () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      return tab !== before && tab?.input;
    });
  }

  it('keeps the selection and details across a refresh', async () => {
    const hash = await selectCommit('Search ranking');
    const before = (await panel.probe()).generation;
    await panel.simulate({ kind: 'click', selector: '.codicon-refresh' });
    const s = await waitFor('reloaded with selection', async () => {
      const p = await panel.probe();
      return p.generation > before && p.detailsShown === hash && p;
    });
    assert.equal(s.selected, hash);
  });

  it('opens a git: diff for a modified file', async () => {
    const hash = await selectCommit('Search ranking');
    const file = git('diff-tree', '--no-commit-id', '--name-only', '-r', `${hash}^`, hash);
    const input = await activeTabInput();
    assert.ok(input instanceof vscode.TabInputTextDiff);
    assert.equal(input.original.scheme, 'git');
    assert.equal(input.modified.scheme, 'git');
    assert.ok(input.modified.path.endsWith(`/${file}`));
    const right = await vscode.workspace.openTextDocument(input.modified);
    const left = await vscode.workspace.openTextDocument(input.original);
    assert.equal(right.getText(), git('show', `${hash}:${file}`) + '\n');
    assert.equal(left.getText(), git('show', `${hash}^:${file}`) + '\n');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  it('opens the new version of an added file', async () => {
    const hash = await selectCommit('Search index');
    const file = git('diff-tree', '--no-commit-id', '--name-only', '-r', `${hash}^`, hash);
    const input = await activeTabInput();
    assert.ok(input instanceof vscode.TabInputText, 'added files open as a single document');
    assert.equal(input.uri.scheme, 'git');
    const doc = await vscode.workspace.openTextDocument(input.uri);
    assert.equal(doc.getText(), git('show', `${hash}:${file}`) + '\n');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  it('keeps its state while a diff is open and marks the file only while its diff is shown', async () => {
    const hash = await selectCommit('Search ranking');
    const file = git('diff-tree', '--no-commit-id', '--name-only', '-r', `${hash}^`, hash);
    await activeTabInput();
    await waitFor('marked while shown', async () => (await panel.probe()).openedFile === file);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    const s = await waitFor('unmarked once closed', async () => {
      const p = await panel.probe();
      return p.openedFile === undefined && p;
    });
    assert.equal(s.selected, hash);
    assert.equal(s.detailsShown, hash);
  });

  async function openView(subject: string, view: FileView): Promise<{ hash: string; file: string; input: unknown }> {
    const hash = await selectCommit(subject);
    const file = git('diff-tree', '--no-commit-id', '--name-only', '-r', `${hash}^`, hash);
    const before = vscode.window.tabGroups.activeTabGroup.activeTab;
    await panel.simulate({ kind: 'clickFile', index: 0, view });
    const input = await waitFor(`${view} tab`, () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      return tab !== before && tab?.input;
    });
    return { hash, file, input };
  }

  it('opens the whole file as it was before the change', async () => {
    const { hash, file, input } = await openView('Search ranking', 'before');
    assert.ok(input instanceof vscode.TabInputText);
    assert.equal(input.uri.scheme, 'git');
    assert.equal(
      (await vscode.workspace.openTextDocument(input.uri)).getText(),
      git('show', `${hash}^:${file}`) + '\n',
    );
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  it('opens the whole file as it is after the change', async () => {
    const { hash, file, input } = await openView('Search ranking', 'after');
    assert.ok(input instanceof vscode.TabInputText);
    assert.equal((await vscode.workspace.openTextDocument(input.uri)).getText(), git('show', `${hash}:${file}`) + '\n');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  it('offers only the views that exist for added files', async () => {
    await selectCommit('Search index');
    const { fileViews } = await panel.probe();
    assert.deepEqual(fileViews, [{ path: 'feature_search.txt', views: ['after'] }]);
  });

  it('opens a diff beside the graph on Alt+click', async () => {
    await selectCommit('Search ranking');
    const groups = vscode.window.tabGroups.all.length;
    await panel.simulate({ kind: 'clickFile', index: 0, altKey: true });
    await waitFor('second editor group', () => vscode.window.tabGroups.all.length === groups + 1);
    await vscode.commands.executeCommand('workbench.action.closeEditorsInGroup');
  });
});

describe('commit-graph command', () => {
  it('writes a commit-graph with changed-path filters and reloads the history', async () => {
    const panel = (await strata()).show();
    await panel.whenReady();
    const info = git('rev-parse', '--git-path', 'objects/info');
    git('commit-graph', 'write', '--reachable'); // make sure the path exists, then remove it
    rmSync(join(workspaceRoot(), info, 'commit-graph'), { force: true });
    const before = (await panel.probe()).generation;
    await vscode.commands.executeCommand('strata.writeCommitGraph');
    assert.ok(existsSync(join(workspaceRoot(), info, 'commit-graph')));
    assert.ok(await hasChangedPaths('git', workspaceRoot()), 'changed-path filters written');
    await waitFor('reload', async () => (await panel.probe()).generation > before);
    panel.dispose();
  });
});
