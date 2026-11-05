import * as assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { StrataTestApi } from '../../src/extension.ts';
import type { GraphPanel } from '../../src/host/panel.ts';
import { git, strata, waitFor, workspaceRoot } from './helpers.ts';
import { gitRetry, setIdentity, snapshotRepo } from './repo-snapshot.ts';
import { ScriptedUi } from './scripted-ui.ts';

describe('operation banner', () => {
  let api: StrataTestApi;
  let panel: GraphPanel;
  let restore: () => Promise<void>;
  const write = (content: string) => {
    writeFileSync(join(workspaceRoot(), 'conflict.txt'), content);
  };
  const banner = (state: string) =>
    waitFor(`banner ${state}`, async () => {
      const s = await panel.probe();
      return s.banner?.state === state && s;
    });

  before(async () => {
    restore = await snapshotRepo();
    await setIdentity();
    api = await strata();
    panel = api.show();
    await panel.whenReady();
    await waitFor('history', async () => (await panel.probe()).done);
    // strata-topic's first commit conflicts with strata-onto.
    await gitRetry('switch', '--quiet', '--create', 'strata-onto', 'main');
    write('onto\n');
    await gitRetry('add', 'conflict.txt');
    await gitRetry('commit', '--quiet', '-m', 'Onto');
    await gitRetry('switch', '--quiet', '--create', 'strata-topic', 'main');
    write('topic\n');
    await gitRetry('add', 'conflict.txt');
    await gitRetry('commit', '--quiet', '-m', 'Topic one');
    writeFileSync(join(workspaceRoot(), 'other.txt'), 'other\n');
    await gitRetry('add', 'other.txt');
    await gitRetry('commit', '--quiet', '-m', 'Topic two');
    await assert.rejects(gitRetry('rebase', 'strata-onto'));
  });
  after(async () => {
    await restore();
    panel.dispose();
  });

  it('names a rebase stopped at a conflict, says it politely, and offers what to do next', async () => {
    const short = git('rev-parse', '--short=7', 'strata-topic~1');
    const text =
      `Rebasing 'strata-topic' onto 'strata-onto' stopped at 1 of 2, "Topic one" (${short}): 1 conflicted file. ` +
      "'strata-topic' keeps its old commits until the rebase finishes.";
    await banner('rebase');
    // The subject shows once the history that has the commit is loaded.
    const s = await waitFor('banner with the subject', async () => {
      const p = await panel.probe();
      return p.banner?.text === text && p;
    });
    assert.equal(s.banner?.label, 'Rebase in progress');
    assert.equal(s.banner.warning, true);
    assert.deepEqual(s.banner.buttons, ['Resolve...', 'Continue', 'Skip...', 'Abort...']);
    assert.match(s.announced, /^Rebasing 'strata-topic' onto 'strata-onto' stopped at 1 of 2/);
    assert.equal(s.alerted, '', 'VS Code already says the toast the host shows for a stop');
  });

  it('marks in the graph the commit the rebase stopped at, and where it goes', async () => {
    const s = await waitFor('rows marked', async () => {
      const p = await panel.probe();
      return Object.keys(p.operationNotes).length === 2 && p;
    });
    assert.deepEqual(s.operationNotes, {
      [git('rev-parse', 'strata-topic~1')]: 'Stopped here: 1 conflicted file',
      [git('rev-parse', 'strata-onto')]: 'Rebasing onto',
    });
  });

  it('runs the command of a button, and selects the commit a link names', async () => {
    await panel.simulate({ kind: 'click', selector: '.banner-button.primary' });
    // Resolve... with one conflicted file opens it.
    const conflict = vscode.Uri.file(join(workspaceRoot(), 'conflict.txt')).toString();
    const tab = await waitFor('conflict.txt opened', () => {
      const t = vscode.window.tabGroups.activeTabGroup.activeTab;
      return t?.input instanceof vscode.TabInputText && t.input.uri.toString() === conflict && t;
    });
    await vscode.window.tabGroups.close(tab);
    await panel.simulate({ kind: 'click', selector: '.banner-link' });
    await waitFor('commit selected', async () => (await panel.probe()).selected === git('rev-parse', 'strata-topic~1'));
  });

  it('holds its buttons while an operation runs, saying what runs, and the host ignores them meanwhile', async () => {
    const host = panel.flowHost();
    const ui = new ScriptedUi();
    const sent: string[] = [];
    const sub = panel.onDidReceiveMessage((m) => {
      if (m.type === 'menuCommand') sent.push(m.command);
    });
    api.setUi(ui);
    try {
      await host.runner.run(host, 'Continuing rebase', false, async () => {
        const s = await waitFor('banner busy', async () => {
          const p = await panel.probe();
          return p.banner?.busy !== undefined && p;
        });
        assert.equal(s.banner?.busy, 'Continuing rebase…');
        assert.equal(s.announced, 'Continuing rebase…');
        await panel.simulate({ kind: 'click', selector: '.banner-button:last-child' });
        await panel.probe();
        assert.deepEqual(sent, [], 'a held button sends nothing');
        // A click the webview sent before it heard of the operation.
        await vscode.commands.executeCommand('strata.operation.abort');
        assert.deepEqual(ui.asked, [], 'nothing asked for a command that cannot run now');
      });
    } finally {
      api.setUi(undefined);
      sub.dispose();
    }
    const s = await waitFor('banner free', async () => {
      const p = await panel.probe();
      return p.banner?.busy === undefined && p;
    });
    assert.deepEqual(s.banner?.buttons, ['Resolve...', 'Continue', 'Skip...', 'Abort...']);
  });

  it('says what Continue does once the conflict is resolved, and keeps focus on the button that had it', async () => {
    await panel.simulate({ kind: 'focus', selector: '.banner-button:last-child' });
    write('resolved\n');
    await gitRetry('add', 'conflict.txt');
    const s = await banner('rebaseResolved');
    assert.equal(
      s.banner?.text,
      'Conflicts resolved. Continue finishes "Topic one" and replays the remaining 1 commit.',
    );
    assert.deepEqual(s.banner.buttons, ['Continue', 'Skip...', 'Abort...']);
    assert.equal(s.focused, 'banner-button', 'Abort..., not the primary Continue');
  });

  it('goes away when the rebase is aborted, handing focus to the list', async () => {
    await panel.simulate({ kind: 'focus', selector: '.banner-button.primary' });
    await gitRetry('rebase', '--abort');
    const s = await waitFor('no banner', async () => {
      const p = await panel.probe();
      return p.banner === undefined && p;
    });
    assert.equal(s.focused, 'scroller');
  });
});
