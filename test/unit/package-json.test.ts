import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { MENU_COMMANDS } from '../../src/shared/menu-commands.ts';

interface MenuItem {
  command: string;
  when?: string;
}
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  activationEvents: string[];
  contributes: { commands: { command: string }[]; menus: Record<string, MenuItem[]> };
};

describe('package.json context menus', () => {
  const declared = new Set(pkg.contributes.commands.map((c) => c.command));
  const webview = pkg.contributes.menus['webview/context'] ?? [];

  it('declares every menu command and shows each in the graph only', () => {
    for (const id of MENU_COMMANDS) assert.ok(declared.has(id), `${id} not in contributes.commands`);
    assert.deepEqual(new Set(webview.map((m) => m.command)), new Set(MENU_COMMANDS));
    for (const m of webview)
      assert.match(m.when ?? '', /webviewId == 'strata\.graph' && webviewSection == '(file|commit)'/);
  });

  it('keeps menu commands out of the command palette', () => {
    const hidden = new Set(
      (pkg.contributes.menus['commandPalette'] ?? []).filter((m) => m.when === 'false').map((m) => m.command),
    );
    for (const id of MENU_COMMANDS) assert.ok(hidden.has(id), `${id} shows in the command palette`);
  });
});

describe('package.json activation', () => {
  it('activates after startup too, to replace a graph an extension host restart left behind', () => {
    // Nothing else wakes Strata then: VS Code does not revive the webview through the serializer.
    assert.ok(pkg.activationEvents.includes('onStartupFinished'));
    assert.ok(pkg.activationEvents.includes('onWebviewPanel:strata.graph'));
  });
});
