import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { GraphPanel } from '../../src/host/panel.ts';
import { git, strata, waitFor } from './helpers.ts';

const TREE = ['docs/', '  guide/', '    intro.md', '    setup.md', '  index.md', 'src/app/', '  main.ts', 'NOTES.md'];

describe('changed files tree', () => {
  let panel: GraphPanel;
  before(async () => {
    panel = (await strata()).show();
    await panel.whenReady();
    await waitFor('history', async () => (await panel.probe()).done);
    const hash = git('log', '--all', '--format=%H', '--fixed-strings', '--grep=Add docs and sources', '-n1');
    const order = git('rev-list', '--topo-order', '--branches', '--remotes', 'HEAD').split('\n');
    if ((await panel.probe()).detailsShown !== hash)
      await panel.simulate({ kind: 'clickRow', index: order.indexOf(hash) });
    await waitFor('details', async () => (await panel.probe()).detailsShown === hash);
  });
  after(() => {
    panel.dispose();
  });

  const tree = async () => (await panel.probe()).fileTree;

  it('shows the changed files as a folder tree', async () => {
    assert.deepEqual(await tree(), TREE);
  });

  it('folds and unfolds a folder by clicking it', async () => {
    await panel.simulate({ kind: 'click', selector: '.expansion .folder[data-path="docs"]' });
    await waitFor(
      'docs folded',
      async () => JSON.stringify(await tree()) === JSON.stringify(['docs/', 'src/app/', '  main.ts', 'NOTES.md']),
    );
    await panel.simulate({ kind: 'click', selector: '.expansion .folder[data-path="docs"]' });
    await waitFor('docs unfolded', async () => JSON.stringify(await tree()) === JSON.stringify(TREE));
  });

  it('folds with Left and unfolds with Right on a focused folder', async () => {
    await panel.simulate({ kind: 'focus', selector: '.expansion .folder[data-path="src/app"]' });
    await panel.simulate({ kind: 'key', key: 'ArrowLeft', target: 'focused' });
    await waitFor('src folded', async () => !(await tree()).includes('  main.ts'));
    await panel.simulate({ kind: 'key', key: 'ArrowRight', target: 'focused' });
    await waitFor('src unfolded', async () => JSON.stringify(await tree()) === JSON.stringify(TREE));
  });

  it('still opens a file from inside the tree', async () => {
    const before = vscode.window.tabGroups.activeTabGroup.activeTab;
    await panel.simulate({ kind: 'clickFile', index: 0 });
    const input = await waitFor('file tab', () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      return tab !== before && tab?.input;
    });
    assert.ok(input instanceof vscode.TabInputText, 'an added file opens its new version');
    assert.ok(input.uri.path.endsWith('/docs/guide/intro.md'));
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });
});
