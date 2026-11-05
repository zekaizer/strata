import * as assert from 'node:assert/strict';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { StrataTestApi } from '../../src/extension.ts';
import { run } from '../integration/flow-helpers.ts';
import { delay, screenshot, strata, waitFor } from '../integration/helpers.ts';
import { allOpen, editIn, rootOf, showing, switchTo } from './helpers.ts';

describe('ways into the graph', () => {
  let api: StrataTestApi;
  const [alpha, beta, gamma] = [rootOf('alpha'), rootOf('beta'), rootOf('beta/vendor/gamma')];
  const panel = () => waitFor('the graph', () => api.current());

  before(async () => {
    api = await strata();
    await allOpen();
  });
  afterEach(async () => {
    const texts = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputText);
    await vscode.window.tabGroups.close(texts);
  });
  after(() => {
    api.current()?.dispose();
  });

  it('opens the repository a Source Control row names', async () => {
    api.current()?.dispose();
    // What VS Code passes from scm/sourceControl and scm/title: the provider's SourceControl.
    await run('strata.openInGraph', { id: 'git', label: 'Git', rootUri: vscode.Uri.file(beta) });
    await showing(await panel(), beta);
    await run('strata.show', { id: 'git', label: 'Git', rootUri: vscode.Uri.file(gamma) });
    await showing(await panel(), gamma);
  });

  it('offers Open in Commit Graph on Source Control rows', async function () {
    const shots = process.env['STRATA_SHOT_DIR'];
    if (!shots) this.skip();
    await vscode.commands.executeCommand('workbench.view.scm');
    await delay(1500);
    await screenshot(join(shots, 'scm-rows.png'));
    await vscode.commands.executeCommand('workbench.view.explorer');
  });

  it('only reveals the graph when the Command Palette runs Show Commit Graph', async () => {
    const p = await panel();
    await switchTo(p, alpha);
    await editIn(beta);
    await run('strata.show');
    await showing(p, alpha);
  });

  it("has a status bar item that opens the active editor's repository", async () => {
    const item = await waitFor('the status bar item', () => api.statusBarItem());
    assert.equal(item.name, 'Strata Commit Graph');
    assert.equal(item.tooltip, 'Show Commit Graph');
    assert.equal(item.text, '$(strata-graph) Graph');
    api.current()?.dispose();
    await editIn(gamma);
    await run(item.command as string);
    await showing(await panel(), gamma);
    await editIn(alpha);
    await run(item.command as string);
    await showing(await panel(), alpha);
  });
});
