// Test-only extension that drives the restart test (scripts/restart-test.mjs).
// It runs in a normal development window, not test mode, because test mode keeps
// workbench storage in memory and nothing would survive the restart.
//   STRATA_RESTART_PHASE=1  open the graph, select a commit, pin the tab, quit
//   STRATA_RESTART_PHASE=2  check the graph came back restored, quit
// The outcome is written as JSON to STRATA_RESTART_RESULT.
import { writeFileSync } from 'node:fs';
import * as vscode from 'vscode';
import type { StrataTestApi } from '../../src/extension.ts';
import { delay, git, waitFor } from '../integration/helpers.ts';

const SUBJECT = 'Login validation';

export function activate(): void {
  const phase = process.env['STRATA_RESTART_PHASE'];
  const result = process.env['STRATA_RESTART_RESULT'];
  if (!phase || !result) return;
  void (async () => {
    let outcome: Record<string, unknown>;
    try {
      outcome = phase === '1' ? await before() : await after();
    } catch (e) {
      outcome = { error: e instanceof Error ? e.message : String(e) };
    }
    writeFileSync(result, JSON.stringify(outcome));
    await vscode.commands.executeCommand('workbench.action.quit');
  })();
}

async function api(): Promise<StrataTestApi> {
  const ext = vscode.extensions.getExtension<StrataTestApi>('zekaizer.strata')!;
  return ext.activate();
}

const target = () => git('log', '--all', '--format=%H', '--fixed-strings', `--grep=${SUBJECT}`, '-n1');

async function before(): Promise<Record<string, unknown>> {
  const panel = (await api()).show();
  await panel.whenReady();
  await waitFor('history', async () => (await panel.probe()).done);
  const hash = target();
  const order = git('rev-list', '--topo-order', '--branches', '--remotes', 'HEAD').split('\n');
  await panel.simulate({ kind: 'clickRow', index: order.indexOf(hash) });
  await waitFor('details', async () => (await panel.probe()).detailsShown === hash);
  await vscode.commands.executeCommand('workbench.action.pinEditor');
  await waitFor('pinned', () => vscode.window.tabGroups.activeTabGroup.activeTab?.isPinned);
  await panel.simulate({ kind: 'click', selector: '.first-parent-button' });
  await waitFor('first parent', async () => (await panel.probe()).options.firstParent);
  // Webview state reaches the workbench asynchronously; let it arrive before quitting.
  await delay(1000);
  return { selected: hash };
}

async function after(): Promise<Record<string, unknown>> {
  // The restored panel activates Strata through onWebviewPanel; nothing here opens it.
  const panel = await waitFor('restored panel', async () => (await api()).current(), 30_000);
  await panel.whenReady();
  const hash = target();
  const restoredSelection = await waitFor(
    'restored selection',
    async () => (await panel.probe()).detailsShown === hash && hash,
    15_000,
  ).catch(() => undefined);
  const tab = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .find((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith('strata.graph'));
  const { options } = await panel.probe();
  return { restored: true, restoredSelection, pinned: tab?.isPinned ?? false, firstParent: options.firstParent };
}
