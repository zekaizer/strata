import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { syncManifest } from '../../scripts/lib/manifest.ts';
import { COMMAND_IDS, COMMANDS, SECTION_KEYS, type CommandSpec } from '../../src/shared/commands.ts';

interface Command {
  command: string;
  enablement?: string;
}
const text = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
const pkg = JSON.parse(text) as {
  activationEvents: string[];
  contributes: { commands: Command[] };
};

describe('package.json commands', () => {
  it('contributes exactly what the command table generates (npm run manifest)', () => {
    assert.equal(text, syncManifest(text));
  });

  it('disables every command that changes the repository while another one runs', () => {
    const byId = new Map(pkg.contributes.commands.map((c) => [c.command, c]));
    for (const id of COMMAND_IDS) {
      const spec: CommandSpec = COMMANDS[id];
      assert.equal(byId.get(id)?.enablement, spec.writes ? '!strata.busy' : undefined, id);
    }
  });

  it("decides a menu's visibility only from context keys its own section carries", () => {
    // A badge's context also holds its row's keys (VS Code merges them), so a badge menu reading a row flag would lie.
    for (const id of COMMAND_IDS) {
      const spec: CommandSpec = COMMANDS[id];
      for (const m of spec.menus ?? []) {
        const allowed: readonly string[] = SECTION_KEYS[m.section];
        for (const key of m.when?.match(/\bstrata[A-Z]\w*/g) ?? [])
          assert.ok(allowed.includes(key), `${id} in ${m.section} menus reads ${key}`);
      }
    }
  });
});

describe('package.json activation', () => {
  it('activates after startup too, to replace a graph an extension host restart left behind', () => {
    // Nothing else wakes Strata then: VS Code does not revive the webview through the serializer.
    assert.ok(pkg.activationEvents.includes('onStartupFinished'));
    assert.ok(pkg.activationEvents.includes('onWebviewPanel:strata.graph'));
  });
});
