// Developer tools that run inside the integration host, enabled by env vars:
//   STRATA_CAPTURE_THEMES=<dir>  dump --vscode-* variables per built-in theme
//   STRATA_SHOT_DIR=<dir>        screenshot the graph panel per built-in theme
import { mkdir, writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { join } from 'node:path';
import { delay, screenshot, setTheme, strata, THEMES, waitFor, type ThemeId } from '../helpers.ts';

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
    panel.dispose();
  });
});
