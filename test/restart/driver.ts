// Test-only extension that drives the restart test (scripts/restart-test.mjs).
// It runs in a normal development window, not test mode, because test mode keeps
// workbench storage in memory and nothing would survive the restart.
//   STRATA_RESTART_PHASE=1  open the graph, select a commit, pin the tab, quit
//   STRATA_RESTART_PHASE=2  check the graph came back restored, quit
//   STRATA_RESTART_PHASE=3  open the graph, restart the extension host, check the graph loads
//                           again in the same window (the driver activates again after it), quit
// The outcome is written as JSON to STRATA_RESTART_RESULT.
import { existsSync, writeFileSync } from 'node:fs';
import * as vscode from 'vscode';
import type { StrataTestApi } from '../../src/extension.ts';
import { delay, git, screenshot, waitFor } from '../integration/helpers.ts';

const SUBJECT = 'Login validation';

export function activate(): void {
  const phase = process.env['STRATA_RESTART_PHASE'];
  const result = process.env['STRATA_RESTART_RESULT'];
  if (!phase || !result) return;
  void (async () => {
    let outcome: Record<string, unknown>;
    const marker = `${result}.restarting`;
    try {
      if (phase === '3' && !existsSync(marker)) {
        await beforeHostRestart();
        writeFileSync(marker, '');
        // The window stays; this extension host and the driver in it go away and come back.
        await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
        return;
      }
      outcome = phase === '1' ? await before() : phase === '2' ? await after() : await afterHostRestart();
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

/** Opens the graph (phase 2 left it restored, first-parent on) at the full history, with a commit selected. */
async function beforeHostRestart(): Promise<void> {
  const panel = (await api()).show();
  await panel.whenReady();
  await waitFor('history', async () => (await panel.probe()).done);
  if ((await panel.probe()).options.firstParent) {
    await panel.simulate({ kind: 'click', selector: '.first-parent-button' });
    await waitFor('full history', async () => {
      const s = await panel.probe();
      return !s.options.firstParent && s.done;
    });
  }
  const hash = target();
  const order = git('rev-list', '--topo-order', '--branches', '--remotes', 'HEAD').split('\n');
  if ((await panel.probe()).detailsShown !== hash)
    await panel.simulate({ kind: 'clickRow', index: order.indexOf(hash) });
  await waitFor('details', async () => (await panel.probe()).detailsShown === hash);
  // Webview state reaches the workbench asynchronously.
  await delay(1000);
}

/** After an extension host restart the graph's webview is still open; it must load again. */
async function afterHostRestart(): Promise<Record<string, unknown>> {
  // Nothing here may activate Strata: it has to wake up by itself (onStartupFinished).
  const woke = await waitFor(
    'Strata activated after the host restart',
    () => vscode.extensions.getExtension('zekaizer.strata')?.isActive,
    30_000,
  ).catch(() => false);
  if (!woke) return { reloaded: false, reason: 'not activated' };
  const panel = await waitFor('graph after host restart', async () => (await api()).current(), 30_000).catch(
    () => undefined,
  );
  if (!panel) {
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.label);
    if (process.env['STRATA_RESTART_SHOT']) await screenshot(process.env['STRATA_RESTART_SHOT']);
    return { reloaded: false, reason: `no panel; tabs: ${tabs.join(', ')}` };
  }
  const loaded = await waitFor(
    'history after host restart',
    async () => {
      const s = await panel.probe();
      return s.done && s.commits > 0 && s;
    },
    20_000,
  ).catch(() => undefined);
  const hash = target();
  const selection = loaded
    ? await waitFor('selection after host restart', async () => (await panel.probe()).detailsShown === hash, 15_000)
        .then(() => true)
        .catch(() => false)
    : false;
  return { reloaded: !!loaded, selection };
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
