// End-to-end first page time in VS Code, run by `npm run perf:e2e` against the
// repository in STRATA_PERF_REPO. Prints results; not part of the regular suite.
import { performance } from 'node:perf_hooks';
import * as vscode from 'vscode';
import { strata, waitFor } from '../integration/helpers.ts';

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
      panel.dispose();
    }
    console.log(`STRATA_PERF ${JSON.stringify({ firstPageMs: times, note: 'run 0 includes git API startup' })}`);
  });
});
