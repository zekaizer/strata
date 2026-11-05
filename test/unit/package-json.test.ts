import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { syncManifest } from '../../scripts/lib/manifest.ts';
import { COMMAND_IDS, COMMANDS, refActions, SECTION_KEYS, type CommandSpec } from '../../src/shared/commands.ts';

interface Command {
  command: string;
  enablement?: string;
}
const text = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
const pkg = JSON.parse(text) as {
  activationEvents: string[];
  contributes: { commands: Command[]; menus: Record<string, { command: string; when?: string }[]> };
};
const webview = pkg.contributes.menus['webview/context'] ?? [];

describe('package.json commands', () => {
  it('contributes exactly what the command table generates (npm run manifest)', () => {
    assert.equal(text, syncManifest(text));
  });

  it('drops the contributions of a command the table no longer has', () => {
    const stale = JSON.parse(text) as typeof pkg;
    stale.contributes.commands.push({ command: 'strata.stash.clear' });
    stale.contributes.menus['webview/context']!.push({
      command: 'strata.stash.clear',
      when: "webviewSection == 'stash'",
    });
    stale.contributes.menus['commandPalette']!.push({ command: 'strata.stash.clear' });
    stale.contributes.menus['scm/title']!.push({ command: 'strata.stash.clear' });
    assert.equal(syncManifest(`${JSON.stringify(stale, null, 2)}\n`), text);
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

  it('shows commit commands on commit rows and only stash commands on stash rows', () => {
    const onCommit = commandsOn(row('commit'));
    for (const id of ['strata.commit.copyHash', 'strata.commit.copyPatch'])
      assert.ok(onCommit.includes(id), `${id} on commit rows`);
    for (const id of commandsOn(row('stash'))) assert.match(id, /^strata\.stash\./, `${id} on stash rows`);
  });

  it('disables every command that changes the repository while another one runs or is stopped', () => {
    const byId = new Map(pkg.contributes.commands.map((c) => [c.command, c]));
    const expected = { true: '!strata.busy && !strata.operation', whileStopped: '!strata.busy' };
    for (const id of COMMAND_IDS) {
      const spec: CommandSpec = COMMANDS[id];
      assert.equal(byId.get(id)?.enablement, spec.writes && expected[String(spec.writes) as keyof typeof expected], id);
    }
    for (const id of [
      'strata.operation.continue',
      'strata.operation.abort',
      'strata.operation.skip',
      'strata.fetch',
      'strata.fetchRemote',
    ])
      assert.equal(byId.get(id)?.enablement, '!strata.busy', `${id} runs while an operation is stopped`);
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

describe('ref actions (keyboard access to badges)', () => {
  it('lists what the menu of that badge would show, from the same table', () => {
    assert.deepEqual(refActions('branch', { strataIsCurrent: true, strataUpstream: true }), [
      'strata.pull',
      'strata.push',
      'strata.renameBranch',
      'strata.copyRefName',
    ]);
    assert.deepEqual(refActions('branch', { strataIsCurrent: false, strataUpstream: false }), [
      'strata.checkout',
      'strata.merge',
      'strata.rebase',
      'strata.publish',
      'strata.renameBranch',
      'strata.copyRefName',
      'strata.deleteBranch',
    ]);
    assert.deepEqual(refActions('remoteBranch', {}), [
      'strata.checkout',
      'strata.merge',
      'strata.rebase',
      'strata.fetchRemote',
      'strata.copyRefName',
      'strata.deleteRemoteBranch',
    ]);
    assert.deepEqual(
      refActions('commit', { strataBranch: 'refs/heads/topic', strataHasRefs: true }).slice(0, 2),
      ['strata.checkout', 'strata.checkoutDetached'],
      "a branch tip's row checks out the branch first",
    );
    assert.deepEqual(refActions('tag', {}), [
      'strata.checkoutDetached',
      'strata.pushTag',
      'strata.copyRefName',
      'strata.deleteTag',
      'strata.deleteRemoteTag',
    ]);
  });
});
