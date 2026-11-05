import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { GraphPanel } from '../../src/host/panel.ts';
import { git, strata, waitFor, workspaceRoot } from './helpers.ts';
import { setIdentity, snapshotRepo } from './repo-snapshot.ts';

/** First page, and the page loaded after it (FIRST_PAGE, NEXT_PAGE in src/webview/main.ts). */
const FIRST_PAGE = 300;
const NEXT_PAGE = 1000;

describe('selection after an operation', () => {
  let panel: GraphPanel;
  let restore: () => Promise<void>;

  before(async () => {
    restore = await snapshotRepo();
    await setIdentity();
    // A long history, so the search for a commit has pages to load.
    const stream = Array.from(
      { length: 1500 },
      (_, i) =>
        `commit refs/heads/strata-long\ncommitter A <a@example.com> ${1_600_000_000 + i} +0000\ndata 1\nc\n` +
        (i === 0 ? 'from refs/heads/main\n' : '') +
        '\n',
    ).join('');
    execFileSync('git', ['fast-import', '--quiet'], { cwd: workspaceRoot(), input: stream });
    panel = (await strata()).show();
    await panel.whenReady();
    await panel.simulate({ kind: 'click', selector: '.codicon-refresh' });
    await waitFor('first page of the long history', async () => (await panel.probe()).commits === FIRST_PAGE);
  });
  after(async () => {
    await restore();
    panel.dispose();
  });

  it('looks for a focus the history lacks only one page past what was loaded', async () => {
    const gone = git('commit-tree', 'HEAD^{tree}', '-m', 'made unreachable by an operation');
    await panel.flowHost().refresh(gone);
    const s = await waitFor('search given up', async () => {
      const p = await panel.probe();
      return p.announced === `${gone.slice(0, 7)} is not in this view` && p;
    });
    assert.equal(s.commits, FIRST_PAGE + NEXT_PAGE);
    assert.equal(s.done, false);
  });
});
