import * as assert from 'node:assert/strict';
import type { StrataTestApi } from '../../src/extension.ts';
import type { GraphPanel } from '../../src/host/panel.ts';
import { commitMenu, reload, run } from '../integration/flow-helpers.ts';
import { strata, waitFor } from '../integration/helpers.ts';
import { ScriptedUi } from '../integration/scripted-ui.ts';
import { allOpen, branchMenuIn, closeRepo, commitTree, gitIn, openRepo, rootOf, startOn } from './helpers.ts';

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
      await startOn(panel, shown);
      assert.equal(api.contextValue('strata.canUndo'), true);
    } finally {
      gitIn(shown, 'checkout', '--quiet', 'main');
      gitIn(shown, 'branch', '-D', 'strata-undo-kept');
    }
  });

  it("acts on a flow's repository when its notification is clicked after the graph moved on", async () => {
    const alpha = rootOf('alpha');
    const beta = rootOf('beta');
    await startOn(panel, alpha);
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
      await startOn(panel, beta);
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
