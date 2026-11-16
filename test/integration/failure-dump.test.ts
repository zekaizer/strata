import * as vscode from 'vscode';
import { strata } from './helpers.ts';

/** How long the dump waits for a webview that may never have booted. */
const PROBE_MS = 5_000;

// A root hook, so it runs after every test of every file. CI keeps only the log of a run, so a
// failure that does not reproduce locally is diagnosed from what this prints.
afterEach(async function () {
  const test = this.currentTest;
  if (test?.state !== 'failed') return;
  const tabs = vscode.window.tabGroups.all.map((g) => g.tabs.map((t) => `${t.label}${t.isActive ? '*' : ''}`));
  const panel = (await strata()).current();
  const state = panel
    ? await Promise.race([
        panel.probe().catch((e: unknown) => `probe failed: ${String(e)}`),
        new Promise((resolve) => setTimeout(resolve, PROBE_MS, 'webview not ready')),
      ])
    : 'no graph panel';
  console.log(`[state after failure] ${test.fullTitle()}\n${JSON.stringify({ tabs, state })}`);
});
