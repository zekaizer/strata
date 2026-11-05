// The README screenshot: the showcase fixture in the dark theme, without the side bar, with a
// pull request merge's changed files unfolded. `npm run shot:readme` runs it.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { delay, git, screenshot, setTheme, strata, waitFor } from '../integration/helpers.ts';

describe('tool: README screenshot', () => {
  it('dark, without the side bar', async () => {
    const dir = process.env['STRATA_SHOT_DIR']!;
    await setTheme('dark');
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    const panel = (await strata()).show();
    await panel.whenReady();
    const merge = git('log', '-1', '--format=%H', '--fixed-strings', '--grep=pull request #27');
    const p = await waitFor('history', async () => {
      const s = await panel.probe();
      return s.done && s;
    });
    const index = Number(Object.entries(p.rowHashes).find(([, h]) => h === merge)?.[0]);
    await panel.simulate({ kind: 'clickRow', index });
    await waitFor('details', async () => (await panel.probe()).detailsShown === merge);
    await delay(Number(process.env['STRATA_SHOT_DELAY'] ?? 800));
    await mkdir(dir, { recursive: true });
    await screenshot(join(dir, 'readme.png'));
  });
});
