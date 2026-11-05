import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { StrataTestApi } from '../../src/extension.ts';
import type { GraphPanel } from '../../src/host/panel.ts';
import { commitMenu, reload, run } from '../integration/flow-helpers.ts';
import { strata, waitFor } from '../integration/helpers.ts';
import { ScriptedUi } from '../integration/scripted-ui.ts';
import {
  allOpen,
  branchMenuIn,
  closeRepo,
  commitTree,
  editIn,
  gitIn,
  openRepo,
  restart,
  rootOf,
  showing,
  switchTo,
} from './helpers.ts';

describe('several repositories', () => {
  const ui = new ScriptedUi();
  let api: StrataTestApi;
  let panel: GraphPanel;
  const [alpha, beta, gamma] = [rootOf('alpha'), rootOf('beta'), rootOf('beta/vendor/gamma')];

  before(async () => {
    api = await strata();
    api.setUi(ui);
    await allOpen();
    panel = api.show();
    await panel.whenReady();
    await waitFor('history', async () => (await panel.probe()).done);
  });
  afterEach(async () => {
    ui.clear();
    const texts = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputText);
    await vscode.window.tabGroups.close(texts);
  });
  after(() => {
    api.setUi(undefined);
    panel.dispose();
  });

  it('moves to another repository when the shown one closes, and says so', async () => {
    await switchTo(panel, gamma);
    await closeRepo(gamma);
    try {
      await waitFor('another repository', async () => {
        const p = await panel.probe();
        return p.repo !== undefined && p.repo !== gamma && p.done;
      });
      assert.match((await panel.probe()).announced, /^gamma was closed; showing (alpha|beta)$/);
    } finally {
      await openRepo(gamma);
    }
  });

  it('offers only Refresh while no repository is open', async () => {
    const roots = [gamma, beta, alpha];
    try {
      for (const root of roots) await closeRepo(root);
      const s = await waitFor('no repository', async () => {
        const p = await panel.probe();
        return p.repoSwitcher.text === 'No git repository' && p;
      });
      assert.deepEqual(s.buttonNames.toolbar, ['Refresh']);
    } finally {
      for (const root of roots) await openRepo(root);
    }
    await waitFor('the toolbar back', async () => {
      const p = await panel.probe();
      return p.done && p.buttonNames.toolbar.some((name) => name.startsWith('Go to HEAD'));
    });
  });

  it('shows the repository it showed last when it starts again, not the active editor’s', async () => {
    await switchTo(panel, gamma);
    await editIn(alpha);
    await restart(panel);
    await showing(panel, gamma);
  });

  it('refuses to show a path that is no open repository', async () => {
    await switchTo(panel, beta);
    assert.equal(await panel.showRepository(`${alpha}/`), false);
    assert.equal(await panel.showRepository('/'), false);
    assert.equal((await panel.probe()).repo, beta);
  });

  it("keeps each repository's view options and selection", async () => {
    await switchTo(panel, alpha);
    await panel.simulate({ kind: 'click', selector: '.first-parent-button' });
    await waitFor('first parent', async () => {
      const p = await panel.probe();
      return p.options.firstParent && p.done;
    });
    await panel.simulate({ kind: 'clickRow', index: 2 });
    const picked = await waitFor('a selection', async () => (await panel.probe()).selected);

    await switchTo(panel, beta);
    let p = await panel.probe();
    assert.equal(p.options.firstParent, false);
    assert.equal(p.selected, undefined);

    await switchTo(panel, alpha);
    await waitFor('the selection back', async () => (await panel.probe()).selected === picked);
    assert.equal((await panel.probe()).options.firstParent, true);
    await panel.simulate({ kind: 'click', selector: '.first-parent-button' });
    p = await panel.probe();
    assert.equal(p.repo, alpha);
  });

  it('keeps Undo when the graph starts again', async () => {
    await switchTo(panel, beta);
    ui.type('strata-undo-kept');
    await run('strata.createBranch', commitMenu(gitIn(beta, 'rev-parse', 'HEAD')));
    try {
      assert.equal(api.contextValue('strata.canUndo'), true);
      await restart(panel);
      await showing(panel, beta);
      assert.equal(api.contextValue('strata.canUndo'), true);
    } finally {
      gitIn(beta, 'checkout', '--quiet', 'main');
      gitIn(beta, 'branch', '-D', 'strata-undo-kept');
    }
  });

  it("acts on a flow's repository when its notification is clicked after the graph moved on", async () => {
    await switchTo(panel, alpha);
    const before = gitIn(alpha, 'rev-parse', 'main');
    gitIn(alpha, 'branch', 'strata-ahead', commitTree(alpha, before, 'Ahead'));
    await reload(panel);
    const toast = ui.later();
    ui.press('Fast-Forward');
    await run('strata.merge', branchMenuIn(alpha, 'strata-ahead'));
    const click = await toast;
    assert.notEqual(gitIn(alpha, 'rev-parse', 'main'), before);
    const betaMain = gitIn(beta, 'rev-parse', 'main');
    try {
      await switchTo(panel, beta);
      ui.clear();
      await click('Undo');
      assert.equal(gitIn(alpha, 'rev-parse', 'main'), before, 'Undo moved main back in alpha');
      assert.equal(gitIn(beta, 'rev-parse', 'main'), betaMain);
      assert.deepEqual(
        ui.asked.filter((q) => q.kind === 'notify' && q.message.startsWith('Undo is no longer')),
        [],
      );
      assert.equal((await panel.probe()).repo, beta, 'the graph stays on beta');
    } finally {
      gitIn(alpha, 'reset', '--hard', '--quiet', before);
      gitIn(alpha, 'branch', '-D', 'strata-ahead');
    }
  });
});
