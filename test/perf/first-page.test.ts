// End-to-end first page time in VS Code, run by `npm run perf:e2e` against the
// repository in STRATA_PERF_REPO. Prints results; not part of the regular suite.
import { performance } from 'node:perf_hooks';
import * as vscode from 'vscode';
import { delay, screenshot, strata, waitFor } from '../integration/helpers.ts';

const FIRST_PAGE = 300;

describe('perf: first page', function () {
  this.timeout(600_000);
  it('measures time from command to a laid out first page', async () => {
    const api = await strata();
    const times: number[] = [];
    for (let i = 0; i < 4; i++) {
      const t = performance.now();
      await vscode.commands.executeCommand('strata.show');
      const panel = api.current()!;
      await waitFor('first page', async () => (await panel.probe()).laidOut >= FIRST_PAGE, 300_000);
      times.push(Math.round(performance.now() - t));
      // STRATA_SHOT_DIR: keep the first run on screen (including any commit-graph offer) and capture it.
      const shots = process.env['STRATA_SHOT_DIR'];
      if (shots && i === 0) {
        await delay(3000);
        await screenshot(`${shots}/perf-first-page.png`);
      }
      panel.dispose();
    }
    console.log(`STRATA_PERF ${JSON.stringify({ firstPageMs: times, note: 'run 0 includes git API startup' })}`);
  });
});
