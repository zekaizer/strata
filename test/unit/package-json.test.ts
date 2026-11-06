import * as assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { syncManifest } from '../../scripts/lib/manifest.ts';
import { COMMAND_IDS, COMMANDS, refActions, SECTION_KEYS, type CommandSpec } from '../../src/shared/commands.ts';

interface Command {
  command: string;
  enablement?: string;
  icon?: string;
}
const text = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
const pkg = JSON.parse(text) as {
  activationEvents: string[];
  contributes: {
    commands: Command[];
    menus: Record<string, { command: string; when?: string }[]>;
    icons?: Record<string, { default: { fontPath: string; fontCharacter: string } }>;
  };
};
const webview = pkg.contributes.menus['webview/context'] ?? [];

describe('package.json commands', () => {
  it('contributes exactly what the command table generates (npm run manifest)', () => {
    assert.equal(text, syncManifest(text));
  });

  it('binds Find Commit... to Ctrl+F (Cmd+F) only while the graph is the active editor', () => {
    const keys = (JSON.parse(text) as { contributes: { keybindings: unknown[] } }).contributes.keybindings;
    assert.deepEqual(keys, [
      { command: 'strata.find', key: 'ctrl+f', mac: 'cmd+f', when: "activeWebviewPanelId == 'strata.graph'" },
    ]);
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

describe('commit row menu', () => {
  /** The row menu's items for these flags, one array per separator-delimited group, in VS Code's order. */
  const groups = (flags: Record<string, unknown>) => {
    const by = new Map<string, string[]>();
    for (const id of refActions('commit', flags)) {
      const spec: CommandSpec = COMMANDS[id];
      const group = spec.menus!.find((m) => m.section === 'commit')!.group.split('@')[0]!;
      by.set(group, [...(by.get(group) ?? []), id]);
    }
    return [...by.values()];
  };

  it('groups checkout and refs, pick, integrate and copy, with Reset last on its own', () => {
    assert.deepEqual(groups({ strataBranch: 'refs/heads/topic', strataHasRefs: true }), [
      ['strata.checkout', 'strata.checkoutDetached', 'strata.createBranch', 'strata.createTag', 'strata.refActions'],
      ['strata.cherryPick', 'strata.revert'],
      ['strata.merge', 'strata.rebase'],
      ['strata.commit.copyHash', 'strata.commit.copyShortHash', 'strata.commit.copySubject', 'strata.commit.copyPatch'],
      ['strata.reset'],
    ]);
  });
});

describe('graph title bar', () => {
  const items = pkg.contributes.menus['editor/title'] ?? [];
  /** Evaluates `key == 'v'`, `key != 'v'`, `key` and `!key` terms joined by &&, as the title bar's clauses use. */
  const holds = (when: string, ctx: Record<string, string | boolean>) =>
    when.split('&&').every((term) => {
      const t = term.trim();
      const cmp = /^([\w.]+) (==|!=) '([^']*)'$/.exec(t);
      if (cmp) return (ctx[cmp[1]!] === cmp[3]) === (cmp[2] === '==');
      assert.match(t, /^!?[\w.]+$/, `unsupported when clause term: ${t}`);
      return t.startsWith('!') ? !ctx[t.slice(1)] : Boolean(ctx[t]);
    });
  const order = (g: string) => {
    const [name = '', at = '0'] = g.split('@');
    return [name, Number(at)] as const;
  };
  /** The icons (navigation) and the overflow menu, in VS Code's order. */
  const bar = (state: Record<string, string | boolean>) => {
    const ctx = { activeWebviewPanelId: 'strata.graph', 'strata.operation': '', ...state };
    const shown = items
      .filter((m) => m.command.startsWith('strata.') && holds(m.when ?? '', ctx))
      .map((m) => ({ id: m.command, at: order((m as { group?: string }).group ?? '') }))
      .sort((a, b) => a.at[0].localeCompare(b.at[0]) || a.at[1] - b.at[1]);
    return {
      icons: shown.filter((m) => m.at[0] === 'navigation').map((m) => m.id),
      overflow: shown.filter((m) => m.at[0] !== 'navigation').map((m) => m.id),
    };
  };

  it('shows Fetch, Pull and Push as icons on a branch with an upstream, Publish Branch on one without', () => {
    assert.deepEqual(bar({ 'strata.head': 'tracking' }).icons, ['strata.fetch', 'strata.pull', 'strata.push']);
    assert.deepEqual(bar({ 'strata.head': 'branch' }).icons, ['strata.fetch', 'strata.publish']);
    assert.deepEqual(bar({ 'strata.head': 'detached' }).icons, ['strata.fetch']);
  });

  it('shows Continue, Abort and Fetch while an operation is stopped', () => {
    const stopped = bar({ 'strata.head': 'tracking', 'strata.operation': 'rebase', 'strata.canUndo': true });
    assert.deepEqual(stopped.icons, ['strata.operation.continue', 'strata.operation.abort', 'strata.fetch']);
    assert.deepEqual(stopped.overflow, [
      'strata.stash.push',
      'strata.stash.pushUntracked',
      'strata.showStashes',
      'strata.operation.skip',
      'strata.undo',
      'strata.showOutput',
    ]);
  });

  it('keeps the stash commands, Undo and Show Git Output in the overflow menu', () => {
    assert.deepEqual(bar({ 'strata.head': 'tracking', 'strata.canUndo': true }).overflow, [
      'strata.stash.push',
      'strata.stash.pushUntracked',
      'strata.showStashes',
      'strata.undo',
      'strata.showOutput',
    ]);
  });
});

describe('uncommitted changes row menu', () => {
  it('stashes the changes or hands them to Source Control; the HEAD row no longer stashes', () => {
    assert.deepEqual(refActions('changes', {}), ['strata.stash.push', 'strata.stash.pushUntracked', 'strata.openScm']);
    const head = refActions('commit', { strataIsHead: true });
    assert.ok(!head.includes('strata.stash.push') && !head.includes('strata.stash.pushUntracked'));
  });
});

describe('worktree menu', () => {
  it('opens, copies and removes a worktree; prunes one whose folder is gone', () => {
    assert.deepEqual(refActions('worktree', {}), [
      'strata.worktree.openNewWindow',
      'strata.worktree.openCurrentWindow',
      'strata.worktree.reveal',
      'strata.worktree.copyPath',
      'strata.worktree.remove',
    ]);
    assert.deepEqual(refActions('worktree', { strataShown: true, strataMain: true })[0], 'strata.worktree.show');
    assert.ok(!refActions('worktree', { strataMain: true }).includes('strata.worktree.remove'));
    assert.deepEqual(refActions('worktree', { strataPrunable: true }), [
      'strata.worktree.copyPath',
      'strata.worktree.prune',
    ]);
  });

  it('hides Reveal in a remote window, whose files are on another machine', () => {
    const reveal = webview.find((m) => m.command === 'strata.worktree.reveal');
    assert.match(reveal?.when ?? '', /!remoteName/);
  });
});

describe('package.json activation', () => {
  it('activates after startup too, to replace a graph an extension host restart left behind', () => {
    // Nothing else wakes Strata then: VS Code does not revive the webview through the serializer.
    assert.ok(pkg.activationEvents.includes('onStartupFinished'));
    assert.ok(pkg.activationEvents.includes('onWebviewPanel:strata.graph'));
  });
});

describe('product icons', () => {
  it("shows the ways into the graph with Strata's icon, from a font the package ships", () => {
    const icon = pkg.contributes.icons?.['strata-graph']?.default;
    assert.ok(icon, 'strata-graph is contributed');
    assert.ok(existsSync(new URL(`../../${icon.fontPath}`, import.meta.url)), `${icon.fontPath} exists`);
    const ignore = readFileSync(new URL('../../.vscodeignore', import.meta.url), 'utf8').split('\n');
    assert.ok(ignore.includes(`!${icon.fontPath}`), `.vscodeignore ships ${icon.fontPath}`);
    for (const id of ['strata.show', 'strata.openInGraph'])
      assert.equal(pkg.contributes.commands.find((c) => c.command === id)?.icon, '$(strata-graph)', id);
  });
});

describe('ref actions (keyboard access to badges)', () => {
  it('lists what the menu of that badge would show, from the same table', () => {
    assert.deepEqual(refActions('branch', { strataIsCurrent: true, strataUpstream: true }), [
      'strata.pull',
      'strata.push',
      'strata.setUpstream',
      'strata.renameBranch',
      'strata.copyRefName',
    ]);
    assert.deepEqual(refActions('branch', { strataIsCurrent: false, strataUpstream: false }), [
      'strata.checkout',
      'strata.merge',
      'strata.rebase',
      'strata.publish',
      'strata.setUpstream',
      'strata.renameBranch',
      'strata.copyRefName',
      'strata.hideBadge',
      'strata.hideSimilarBadges',
      'strata.deleteBranch',
    ]);
    assert.deepEqual(refActions('branch', { strataIsCurrent: false, strataUpstream: true, strataInWorktree: true }), [
      'strata.merge',
      'strata.rebase',
      'strata.push',
      'strata.setUpstream',
      'strata.copyRefName',
    ]);
    assert.deepEqual(refActions('remoteBranch', {}), [
      'strata.checkout',
      'strata.merge',
      'strata.rebase',
      'strata.fetchRemote',
      'strata.copyRefName',
      'strata.hideBadge',
      'strata.hideSimilarBadges',
      'strata.deleteRemoteBranch',
    ]);
    assert.deepEqual(refActions('tag', {}), [
      'strata.checkoutDetached',
      'strata.pushTag',
      'strata.copyRefName',
      'strata.hideBadge',
      'strata.hideSimilarBadges',
      'strata.deleteTag',
      'strata.deleteRemoteTag',
    ]);
  });
});
