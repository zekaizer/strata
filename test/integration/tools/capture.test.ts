// Developer tools that run inside the integration host, enabled by env vars:
//   STRATA_CAPTURE_THEMES=<dir>  dump --vscode-* variables per built-in theme
//   STRATA_SHOT_DIR=<dir>        screenshot the graph panel per built-in theme
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { delay, screenshot, setTheme, strata, THEMES, type ThemeId } from '../helpers.ts';

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
      await delay(Number(process.env['STRATA_SHOT_DELAY'] ?? 800));
      await mkdir(shotDir!, { recursive: true });
      await screenshot(join(shotDir!, `${id}.png`));
      panel.dispose();
    });
  }
});
