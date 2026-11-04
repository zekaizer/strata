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

  /** Evaluates the `key == 'value' && flag && !flag` clauses the graph's menus use against a menu context. */
  const shows = (when: string, ctx: Record<string, unknown>): boolean =>
    when.split('&&').every((term) => {
      const t = term.trim();
      const eq = /^(\w+) == '([^']*)'$/.exec(t);
      if (eq) return ctx[eq[1]!] === eq[2];
      assert.match(t, /^!?\w+$/, `unsupported when clause term: ${t}`);
      return t.startsWith('!') ? !ctx[t.slice(1)] : Boolean(ctx[t]);
    });
  const row = (section: string) => ({
    webviewId: 'strata.graph',
    webviewSection: section,
    strataHash: 'a'.repeat(40),
    strataSubject: 'On main: wip',
  });
  const commandsOn = (ctx: Record<string, unknown>) =>
    webview.filter((m) => shows(m.when ?? '', ctx)).map((m) => m.command);

  it('shows the commit commands on commit rows and none on stash rows', () => {
    assert.deepEqual(commandsOn(row('commit')), [
      'strata.commit.copyHash',
      'strata.commit.copyShortHash',
      'strata.commit.copySubject',
      'strata.commit.copyPatch',
    ]);
    assert.deepEqual(commandsOn(row('stash')), []);
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
