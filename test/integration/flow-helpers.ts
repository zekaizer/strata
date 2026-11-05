import * as vscode from 'vscode';
import type { StrataTestApi } from '../../src/extension.ts';
import type { GraphPanel } from '../../src/host/panel.ts';
import { git, strata, waitFor } from './helpers.ts';
import { setIdentity, snapshotRepo } from './repo-snapshot.ts';
import { ScriptedUi } from './scripted-ui.ts';

/** What VS Code passes to a webview/context command: the element's data-vscode-context plus the webview id. */
export const menu = (ctx: Record<string, unknown>) => ({ webview: 'strata.graph', ...ctx });

export const commitMenu = (hash: string) =>
  menu({ webviewSection: 'commit', strataHash: hash, strataSubject: '', strataIsHead: false });

/** A local branch badge; `name` need not exist (a stale menu). */
export const branchMenu = (name: string, hash = git('rev-parse', 'HEAD')) =>
  menu({
    webviewSection: 'branch',
    strataRef: `refs/heads/${name}`,
    strataHash: hash,
    strataIsCurrent: false,
    strataUpstream: false,
  });

export const tagMenu = (name: string) =>
  menu({ webviewSection: 'tag', strataRef: `refs/tags/${name}`, strataHash: git('rev-parse', `${name}^{commit}`) });

export const run = (command: string, arg?: unknown): Promise<unknown> =>
  Promise.resolve(vscode.commands.executeCommand(command, arg));

/** Reloads the graph and waits for the new history; the host's refs are current afterwards. */
export async function reload(panel: GraphPanel): Promise<void> {
  const before = (await panel.probe()).generation;
  await panel.simulate({ kind: 'click', selector: '.codicon-refresh' });
  await waitFor('reloaded', async () => (await panel.probe()).generation > before);
}

export const selected = (panel: GraphPanel, hash: string) =>
  waitFor(`selection of ${hash}`, async () => (await panel.probe()).selected === hash);

/** The row of stash commit `hash`, once the graph draws it. */
export const stashRow = (panel: GraphPanel, hash: string) =>
  waitFor(`the row of stash ${hash}`, async () => {
    const p = await panel.probe();
    const i = Object.entries(p.rowHashes).find(([, h]) => h === hash)?.[0];
    return i !== undefined && p.stashRows[Number(i)];
  });

/**
 * A graph whose flows answer from `ui`, on the workspace repository restored after every test.
 * Call in a describe body.
 */
export function flowSuite(): { api: () => StrataTestApi; panel: () => GraphPanel; ui: ScriptedUi } {
  const ui = new ScriptedUi();
  let api: StrataTestApi | undefined;
  let panel: GraphPanel | undefined;
  let restore: (() => Promise<void>) | undefined;
  before(async () => {
    restore = await snapshotRepo();
    await setIdentity();
    api = await strata();
    api.setUi(ui);
    panel = api.show();
    await panel.whenReady();
    await waitFor('history', async () => (await panel!.probe()).done);
  });
  afterEach(async () => {
    await restore?.();
    await setIdentity();
    ui.clear();
    if (panel) await reload(panel);
  });
  after(async () => {
    api?.setUi(undefined);
    await restore?.();
    panel?.dispose();
  });
  return { api: () => api!, panel: () => panel!, ui };
}
