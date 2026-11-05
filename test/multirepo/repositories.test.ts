import * as assert from 'node:assert/strict';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { StrataTestApi } from '../../src/extension.ts';
import type { GraphPanel } from '../../src/host/panel.ts';
import { commitMenu, run } from '../integration/flow-helpers.ts';
import { strata, waitFor } from '../integration/helpers.ts';
import { ScriptedUi } from '../integration/scripted-ui.ts';
import { allOpen, closeRepo, gitIn, openRepo, showing } from './helpers.ts';

describe('several repositories', () => {
  const ui = new ScriptedUi();
  let api: StrataTestApi;
  let panel: GraphPanel;

  before(async () => {
    api = await strata();
    api.setUi(ui);
    await allOpen();
    panel = api.show();
    await panel.whenReady();
    await waitFor('history', async () => (await panel.probe()).done);
  });
  afterEach(() => {
    ui.clear();
  });
  after(() => {
    api.setUi(undefined);
    panel.dispose();
  });

  it('moves to another repository when the shown one closes', async () => {
    const shown = (await panel.probe()).repo!;
    await closeRepo(shown);
    try {
      await waitFor('another repository', async () => {
        const p = await panel.probe();
        return p.repo !== undefined && p.repo !== shown && p.done;
      });
    } finally {
      await openRepo(shown);
    }
  });

  it('keeps Undo when the graph starts again', async () => {
    const shown = (await panel.probe()).repo!;
    const head = gitIn(shown, 'rev-parse', 'HEAD');
    ui.type('strata-undo-kept');
    await run('strata.createBranch', commitMenu(head));
    try {
      assert.equal(api.contextValue('strata.canUndo'), true);
      // The graph starts again on the active editor's repository.
      const file = gitIn(shown, 'ls-files').split('\n')[0]!;
      await vscode.window.showTextDocument(vscode.Uri.file(join(shown, file)), { preview: true });
      const before = (await panel.probe()).generation;
      await vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction');
      await waitFor('the reloaded graph', async () => {
        const p = await panel.probe().catch(() => undefined);
        return p !== undefined && p.generation !== before && p.done;
      });
      await showing(panel, shown);
      assert.equal(api.contextValue('strata.canUndo'), true);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      gitIn(shown, 'checkout', '--quiet', 'main');
      gitIn(shown, 'branch', '-D', 'strata-undo-kept');
    }
  });
});
