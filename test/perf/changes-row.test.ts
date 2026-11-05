// Latency of the uncommitted changes row in VS Code, run by `npm run perf:e2e` against
// STRATA_PERF_REPO. Writes to one tracked file of that repository and restores it: point it at a
// clone made for the purpose. Prints results; not part of the regular suite.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import * as vscode from 'vscode';
import { getGitApi } from '../../src/host/git-api.ts';
import { git, strata, waitFor, workspaceRoot } from '../integration/helpers.ts';

describe('perf: uncommitted changes row', function () {
  this.timeout(600_000);
  it('measures a save to the row showing, and a revert to it going', async () => {
    const api = await strata();
    const panel = api.show();
    await panel.whenReady();
    await waitFor('first page', async () => (await panel.probe()).laidOut >= 300, 300_000, 10);
    // The row is above HEAD, which need not be near the top: the rows around HEAD are drawn.
    const head = git('rev-parse', 'HEAD');
    await vscode.commands.executeCommand('strata.goToHead');
    await waitFor('HEAD drawn', async () => Object.values((await panel.probe()).rowHashes).includes(head), 300_000);
    const hasRow = async () => Object.values((await panel.probe()).rowHashes).includes('changes');
    await waitFor('a clean work tree', async () => !(await hasRow()), 60_000);
    // A file at the top: listing every file overflows execFileSync on a large repository.
    const top = git('ls-tree', '-z', 'HEAD').split('\0');
    const file = join(workspaceRoot(), top.find((e) => e.includes(' blob '))!.split('\t')[1]!);
    const original = readFileSync(file);
    const repo = (await getGitApi()).repositories[0]!;
    /** Milliseconds from writing `content` to vscode.git's status event and to the row being `shown`. */
    const measure = async (content: Buffer, shown: boolean) => {
      let gitEvent: number | undefined;
      const sub = repo.state.onDidChange(() => {
        gitEvent ??= performance.now();
      });
      const t = performance.now();
      writeFileSync(file, content);
      await waitFor('row', async () => (await hasRow()) === shown, 60_000, 5);
      const done = performance.now();
      sub.dispose();
      return { total: Math.round(done - t), vscodeGit: Math.round((gitEvent ?? done) - t) };
    };
    const shown = [];
    const gone = [];
    try {
      for (let i = 0; i < 5; i++) {
        shown.push(await measure(Buffer.concat([original, Buffer.from('\n')]), true));
        gone.push(await measure(original, false));
      }
    } finally {
      writeFileSync(file, original);
    }
    console.log(`STRATA_PERF ${JSON.stringify({ file, rowShownMs: shown, rowGoneMs: gone })}`);
    panel.dispose();
  });
});
