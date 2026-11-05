// Developer tools that run inside the integration host, enabled by env vars:
//   STRATA_CAPTURE_THEMES=<dir>  dump --vscode-* variables per built-in theme
//   STRATA_SHOT_DIR=<dir>        screenshot the graph panel per built-in theme
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { join } from 'node:path';
import { addBranchyStashes } from '../../fixtures/stashes.ts';
import { delay, git, screenshot, setTheme, strata, THEMES, waitFor, workspaceRoot, type ThemeId } from '../helpers.ts';
import { gitRetry, gitSettled, setIdentity, snapshotRepo } from '../repo-snapshot.ts';

const themeIds = Object.keys(THEMES) as ThemeId[];
const themesDir = process.env['STRATA_CAPTURE_THEMES'];
const shotDir = process.env['STRATA_SHOT_DIR'];

// The theme is a global setting persisted in the reused user-data-dir.
after(() => setTheme('dark'));

(themesDir ? describe : describe.skip)('tool: capture theme variables', () => {
  for (const id of themeIds) {
    it(id, async () => {
      await setTheme(id);
      const panel = (await strata()).show();
      await panel.whenReady();
      await delay(300);
      const vars = await panel.readThemeVars();
      const sorted = Object.fromEntries(Object.entries(vars).sort(([a], [b]) => a.localeCompare(b)));
      await mkdir(themesDir!, { recursive: true });
      await writeFile(join(themesDir!, `${id}.json`), JSON.stringify(sorted, null, 2) + '\n');
      panel.dispose();
    });
  }
});

(shotDir ? describe : describe.skip)('tool: screenshots', () => {
  for (const id of themeIds) {
    it(id, async () => {
      await setTheme(id);
      const panel = (await strata()).show();
      await panel.whenReady();
      // Show a merge commit with its details, the most informative state.
      await waitFor('history', async () => (await panel.probe()).done);
      await panel.simulate({ kind: 'clickRow', index: 1 });
      await waitFor('details', async () => (await panel.probe()).detailsShown !== undefined);
      await delay(Number(process.env['STRATA_SHOT_DELAY'] ?? 800));
      await mkdir(shotDir!, { recursive: true });
      await screenshot(join(shotDir!, `${id}.png`));
      panel.dispose();
    });
  }
});

(shotDir ? describe : describe.skip)('tool: stash screenshots', () => {
  let stashes: string[] = [];
  before(() => {
    stashes = addBranchyStashes(workspaceRoot()).reverse();
  });
  after(() => {
    git('stash', 'clear');
  });

  for (const id of themeIds) {
    it(id, async () => {
      await setTheme(id);
      const panel = (await strata()).show();
      await panel.whenReady();
      // Two stashes on one base, with the upper one's details open; the autostash shows below.
      const p = await waitFor('stash rows', async () => {
        const s = await panel.probe();
        return s.done && Object.keys(s.stashRows).length === 4 && s;
      });
      const index = Number(Object.entries(p.rowHashes).find(([, h]) => h === stashes[2])?.[0]);
      await panel.simulate({ kind: 'clickRow', index });
      await waitFor('details', async () => (await panel.probe()).detailsShown === stashes[2]);
      await delay(Number(process.env['STRATA_SHOT_DELAY'] ?? 800));
      await mkdir(shotDir!, { recursive: true });
      await screenshot(join(shotDir!, `stashes-${id}.png`));
      await panel.simulate({ kind: 'click', selector: '.stash-button' });
      await delay(800);
      await screenshot(join(shotDir!, `stashes-pick-${id}.png`));
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      panel.dispose();
    });
  }
});

(shotDir ? describe : describe.skip)('tool: workflow screenshots', () => {
  let restore: () => Promise<void>;
  const write = (file: string, content: string) => {
    writeFileSync(join(workspaceRoot(), file), content);
  };
  before(async () => {
    restore = await snapshotRepo();
    await setIdentity();
    await gitRetry('remote', 'add', 'origin', 'https://example.com/origin.git');
    await gitRetry('update-ref', 'refs/remotes/origin/main', 'main');
    // A rebase stopped at a conflict, for the banner.
    await gitRetry('switch', '--quiet', '--create', 'strata-onto', 'main');
    write('conflict.txt', 'onto\n');
    await gitRetry('add', 'conflict.txt');
    await gitRetry('commit', '--quiet', '-m', 'Onto');
    await gitRetry('switch', '--quiet', '--create', 'strata-topic', 'main');
    write('conflict.txt', 'topic\n');
    await gitRetry('add', 'conflict.txt');
    await gitRetry('commit', '--quiet', '-m', 'Topic one');
    write('other.txt', 'other\n');
    await gitRetry('add', 'other.txt');
    await gitRetry('commit', '--quiet', '-m', 'Topic two');
    await gitRetry('rebase', 'strata-onto').catch(() => undefined);
    await gitSettled();
  });
  after(() => restore());

  for (const id of themeIds) {
    it(id, async () => {
      await setTheme(id);
      const panel = (await strata()).show();
      await panel.whenReady();
      await waitFor('banner', async () => (await panel.probe()).banner !== undefined);
      await mkdir(shotDir!, { recursive: true });
      // The banner, with an operation running.
      const host = panel.flowHost();
      await host.runner.run(host, 'Rebasing strata-topic onto strata-onto', false, async () => {
        await waitFor('busy', async () => (await panel.probe()).listBusy);
        await delay(Number(process.env['STRATA_SHOT_DELAY'] ?? 800));
        await screenshot(join(shotDir!, `workflow-${id}.png`));
      });
      // A right-click on a remote name: its menu, or the nearest that has one, outlined.
      await panel.simulate({ kind: 'contextMenu', selector: '.badge-remote-name' });
      await delay(800);
      await screenshot(join(shotDir!, `workflow-menu-${id}.png`));
      await vscode.commands.executeCommand('workbench.action.quickOpen');
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      panel.dispose();
    });
  }
});

(shotDir ? describe : describe.skip)('tool: hidden badge screenshots', () => {
  for (const id of themeIds) {
    it(id, async () => {
      await setTheme(id);
      const panel = (await strata()).show();
      await panel.whenReady();
      await waitFor('history', async () => (await panel.probe()).done);
      // A rule in the badge filter and the toolbar's count, with the next pattern previewed.
      await panel.simulate({ kind: 'click', selector: '.badge-filter-button' });
      await panel.simulate({ kind: 'type', selector: '.badge-pattern', text: 'cross/*' });
      await panel.simulate({ kind: 'click', selector: '.badge-hide' });
      await waitFor('rule applied', async () => (await panel.probe()).badgeFilter.button.includes('hidden'));
      await panel.simulate({ kind: 'type', selector: '.badge-pattern', text: 'feature/*' });
      await delay(Number(process.env['STRATA_SHOT_DELAY'] ?? 800));
      await mkdir(shotDir!, { recursive: true });
      await screenshot(join(shotDir!, `hidden-badges-${id}.png`));
      // The ref card of a commit whose badge the rule hides.
      await panel.simulate({ kind: 'key', key: 'Escape' });
      const x = git('rev-parse', 'cross/x');
      const row = Number(Object.entries((await panel.probe()).rowHashes).find(([, h]) => h === x)?.[0]);
      await panel.simulate({ kind: 'hoverNode', index: row });
      await waitFor('ref card', async () => (await panel.probe()).refCard !== undefined);
      await delay(Number(process.env['STRATA_SHOT_DELAY'] ?? 800));
      await screenshot(join(shotDir!, `ref-card-${id}.png`));
      await panel.simulate({ kind: 'click', selector: '.badge-filter-button' });
      await panel.simulate({ kind: 'click', selector: '.popover-rule button[aria-label^="Remove"]' });
      await waitFor('rule removed', async () => !(await panel.probe()).badgeFilter.button.includes('hidden'));
      panel.dispose();
    });
  }
});

(shotDir ? describe : describe.skip)('tool: worktree screenshots', () => {
  let root = '';
  const search = () => join(root, 'strata-search');
  const bisect = () => join(root, 'bisect');
  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'strata-wt-shot-'));
    git('worktree', 'add', '--quiet', search(), 'feature/search');
    git('worktree', 'lock', '--reason', 'on usb disk', search());
    git('worktree', 'add', '--quiet', '--detach', bisect(), 'cross/x');
    await gitSettled();
  });
  after(() => {
    git('worktree', 'remove', '--force', '--force', search());
    git('worktree', 'remove', '--force', bisect());
    rmSync(root, { recursive: true, force: true });
  });

  for (const id of themeIds) {
    it(id, async () => {
      await setTheme(id);
      const panel = (await strata()).show();
      await panel.whenReady();
      await waitFor('worktree badges', async () => {
        const p = await panel.probe();
        return (
          p.done &&
          Object.values(p.menuContexts.badges)
            .flat()
            .some((c) => c['webviewSection'] === 'worktree')
        );
      });
      await mkdir(shotDir!, { recursive: true });
      await delay(Number(process.env['STRATA_SHOT_DELAY'] ?? 800));
      await screenshot(join(shotDir!, `worktrees-${id}.png`));
      const tip = git('rev-parse', 'feature/search');
      const row = Number(Object.entries((await panel.probe()).rowHashes).find(([, h]) => h === tip)?.[0]);
      await panel.simulate({ kind: 'hoverNode', index: row });
      await waitFor('ref card', async () => (await panel.probe()).refCard !== undefined);
      await delay(Number(process.env['STRATA_SHOT_DELAY'] ?? 800));
      await screenshot(join(shotDir!, `worktrees-card-${id}.png`));
      await panel.simulate({ kind: 'contextMenu', selector: '.chip-part' });
      await delay(800);
      await screenshot(join(shotDir!, `worktrees-menu-${id}.png`));
      await vscode.commands.executeCommand('workbench.action.quickOpen');
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      panel.dispose();
    });
  }
});

// STRATA_MENU_SHOT_DIR=<dir>: screenshot the file and commit context menus.
const menuDir = process.env['STRATA_MENU_SHOT_DIR'];
(menuDir ? describe : describe.skip)('tool: context menu screenshots', () => {
  it('file and commit menus', async () => {
    await setTheme('dark');
    const panel = (await strata()).show();
    await panel.whenReady();
    await waitFor('history', async () => (await panel.probe()).done);
    await panel.simulate({ kind: 'clickRow', index: 8 });
    await waitFor('details', async () => (await panel.probe()).detailsShown !== undefined);
    await mkdir(menuDir!, { recursive: true });
    await panel.simulate({ kind: 'contextMenu', selector: '.expansion .file' });
    await delay(800);
    await screenshot(join(menuDir!, 'file-menu.png'));
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await delay(300);
    await panel.simulate({ kind: 'contextMenu', selector: '.row.selected' });
    await delay(800);
    await screenshot(join(menuDir!, 'commit-menu.png'));
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await delay(300);
    await panel.simulate({ kind: 'clickRow', index: 0 });
    await waitFor('HEAD details', async () => (await panel.probe()).detailsShown !== undefined);
    await panel.simulate({ kind: 'contextMenu', selector: '.row.selected' });
    await delay(800);
    await screenshot(join(menuDir!, 'head-menu.png'));
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await delay(300);
    await panel.simulate({ kind: 'clickRow', index: 1, shiftKey: true });
    await waitFor('a selection', async () => (await panel.probe()).selection.length === 2);
    await panel.simulate({ kind: 'contextMenu', selector: '.row.selected' });
    await delay(800);
    await screenshot(join(menuDir!, 'selection-menu.png'));
    panel.dispose();
  });
});

(shotDir ? describe : describe.skip)('tool: find screenshots', () => {
  for (const id of themeIds) {
    it(id, async () => {
      await setTheme(id);
      const panel = (await strata()).show();
      await panel.whenReady();
      await waitFor('history', async () => (await panel.probe()).done);
      await panel.simulate({ kind: 'click', selector: '.find-button' });
      await panel.simulate({ kind: 'type', selector: '.find-input', text: 'search' });
      await waitFor('matches', async () => (await panel.probe()).find.done);
      await delay(Number(process.env['STRATA_SHOT_DELAY'] ?? 800));
      await mkdir(shotDir!, { recursive: true });
      await screenshot(join(shotDir!, `find-${id}.png`));
      await panel.simulate({ kind: 'click', selector: '.find-toggle' });
      await waitFor('list', async () => (await panel.probe()).find.list !== undefined);
      await delay(300);
      await screenshot(join(shotDir!, `find-list-${id}.png`));
      await panel.simulate({ kind: 'click', selector: '.find-toggle' });
      await panel.simulate({ kind: 'click', selector: '.find-widget .codicon-close' });
      panel.dispose();
    });
  }
});

(shotDir ? describe : describe.skip)('tool: path history screenshots', () => {
  for (const id of themeIds) {
    it(id, async () => {
      await setTheme(id);
      const panel = (await strata()).show();
      await panel.whenReady();
      // A file changed on a merged branch: dimmed tips, the merge's details with the file marked.
      await vscode.commands.executeCommand(
        'strata.showHistory',
        vscode.Uri.file(join(workspaceRoot(), 'feature_search.txt')),
      );
      const p = await waitFor('path history', async () => {
        const s = await panel.probe();
        return s.done && s.options.path !== null && s;
      });
      const index = Number(Object.entries(p.rowHashes).find(([, h]) => h === git('rev-parse', 'feature/search'))?.[0]);
      await panel.simulate({ kind: 'clickRow', index });
      await waitFor('details', async () => (await panel.probe()).detailsShown !== undefined);
      await delay(Number(process.env['STRATA_SHOT_DELAY'] ?? 800));
      await mkdir(shotDir!, { recursive: true });
      await screenshot(join(shotDir!, `path-${id}.png`));
      await panel.simulate({ kind: 'click', selector: '.path-chip-main' });
      await delay(500);
      await screenshot(join(shotDir!, `path-popover-${id}.png`));
      await panel.simulate({ kind: 'click', selector: '.path-chip-clear' });
      await waitFor('whole history', async () => (await panel.probe()).options.path === null);
      panel.dispose();
    });
  }
});
