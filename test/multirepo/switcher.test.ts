import * as assert from 'node:assert/strict';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { StrataTestApi } from '../../src/extension.ts';
import type { GraphPanel } from '../../src/host/panel.ts';
import { run } from '../integration/flow-helpers.ts';
import { delay, screenshot, strata, waitFor } from '../integration/helpers.ts';
import { ScriptedUi } from '../integration/scripted-ui.ts';
import { allOpen, rootOf, showing, switchTo } from './helpers.ts';

const graphTab = () =>
  vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .find((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith('strata.graph'));

describe('the repository switcher', () => {
  const ui = new ScriptedUi();
  let api: StrataTestApi;
  let panel: GraphPanel;
  const [alpha, beta, gamma] = [rootOf('alpha'), rootOf('beta'), rootOf('beta/vendor/gamma')];
  const rows = async () => (await panel.probe()).repoSwitcher.rows;

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

  it("lists VS Code's repositories with their place and branch, marking the shown one", async () => {
    await switchTo(panel, alpha);
    const p = await panel.probe();
    assert.equal(p.repoSwitcher.button, true);
    assert.equal(p.repoSwitcher.text, 'alpha');
    await panel.simulate({ kind: 'click', selector: '.repo-button' });
    const listed = await waitFor('the switcher rows', rows);
    assert.deepEqual([...listed].sort(), ['alpha | main | shown', 'beta | main', 'gamma | beta/vendor/gamma | main']);
    assert.equal((await panel.probe()).repoSwitcher.search, false, 'no search box for three repositories');
    const shots = process.env['STRATA_SHOT_DIR'];
    if (shots) {
      await delay(800);
      await screenshot(join(shots, 'repo-switcher.png'));
    }
    await panel.simulate({ kind: 'key', key: 'Escape', target: 'focused' });
    await waitFor('the switcher to close', async () => (await rows()) === undefined);
  });

  it('shows the repository chosen in it', async () => {
    await switchTo(panel, alpha);
    await panel.simulate({ kind: 'click', selector: '.repo-button' });
    await waitFor('the switcher rows', rows);
    await panel.simulate({ kind: 'click', selector: `.repo-row[data-root="${beta}"]` });
    await showing(panel, beta);
    assert.equal(await rows(), undefined);
  });

  it('names the shown repository in the panel title', async () => {
    await switchTo(panel, gamma);
    await waitFor('the title', () => graphTab()?.label === 'gamma');
  });

  it('switches with Switch Repository... from the Command Palette', async () => {
    await switchTo(panel, alpha);
    assert.equal(api.contextValue('strata.repositories'), 3);
    ui.choose('gamma');
    await run('strata.switchRepository');
    await showing(panel, gamma);
    const pick = ui.asked.find((q) => q.kind === 'pick');
    assert.deepEqual(pick?.kind === 'pick' && [...pick.items].sort(), ['alpha', 'beta', 'gamma']);
  });
});
