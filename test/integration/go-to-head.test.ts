import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { ProbeState } from '../../src/shared/protocol.ts';
import { reload, reloadAndSelectTip, flowSuite, run } from './flow-helpers.ts';
import { git, waitFor, workspaceRoot } from './helpers.ts';
import { gitRetry } from './repo-snapshot.ts';

/** First page of history the graph loads (main.ts FIRST_PAGE). */
const FIRST_PAGE = 300;

describe('go to HEAD', () => {
  const { panel, ui } = flowSuite();
  const until = (what: string, test: (s: ProbeState) => boolean) =>
    waitFor(what, async () => {
      const s = await panel().probe();
      return test(s) && s;
    });
  /** Whether row `hash` is rendered within the visible part of the list. */
  const inView = (s: ProbeState, hash: string) => {
    const row = Object.entries(s.rowHashes).find(([, h]) => h === hash)?.[0];
    if (row === undefined) return false;
    const top = s.rowTops[Number(row)]! - s.scrollTop;
    return top >= 0 && top + s.rowHeights[Number(row)]! <= s.listHeight;
  };
  const goToHead = () => panel().simulate({ kind: 'click', selector: '.head-button' });
  /** Ticks or unticks a ref in the branch filter (null: Show All) and waits for the history it shows. */
  const filter = async (ref: string | null, whole = true) => {
    const before = (await panel().probe()).generation;
    await panel().simulate({ kind: 'click', selector: '.ref-filter-button' });
    await panel().simulate({ kind: 'click', selector: ref === null ? '.popover-all' : `input[data-ref="${ref}"]` });
    await panel().simulate({ kind: 'key', key: 'Escape' });
    return until(
      whole ? 'filtered history' : 'its first page',
      (s) => s.generation > before && (whole ? s.done : s.commits > 0),
    );
  };
  /** Writes `count` commits on `branch`, newer than the rest: on top of `from`, or a history of their own. */
  const longBranch = (branch: string, count: number, from?: string) => {
    const start = Math.floor(Date.now() / 1000) + 1000;
    const stream = Array.from(
      { length: count },
      (_, i) =>
        `commit refs/heads/${branch}\ncommitter Ada Lovelace <ada@example.com> ${start + i} +0000\ndata 6\nlong ${i % 10}\n${i === 0 && from ? `from ${from}\n` : ''}\n`,
    ).join('');
    execFileSync('git', ['fast-import', '--quiet'], { cwd: workspaceRoot(), input: stream });
  };

  afterEach(async () => {
    if ((await panel().probe()).options.refs !== null) await filter(null);
  });

  it('selects and reveals HEAD, focusing the list', async () => {
    const head = git('rev-parse', 'HEAD');
    await panel().simulate({ kind: 'scrollToRow', index: 18 });
    await panel().simulate({ kind: 'clickRow', index: 18 });
    await until('another row selected', (s) => s.selected !== undefined && s.selected !== head);
    await goToHead();
    const s = await until('HEAD selected', (p) => p.selected === head);
    assert.ok(inView(s, head), 'HEAD row in view');
    assert.match(s.focused, /scroller/);
  });

  it('loads further history until HEAD shows up', async () => {
    // Newer commits on another branch push HEAD past the first page.
    const main = git('rev-parse', 'main');
    longBranch('strata-long', FIRST_PAGE + 100, main);
    // The reload looks for the selection kept from before; a new one near the top is found at once.
    await reloadAndSelectTip(panel(), 'strata-long');
    await reload(panel());
    let s = await until('first page', (p) => p.commits > 0 && p.selected !== undefined);
    assert.ok(s.commits <= FIRST_PAGE && !s.done, 'HEAD is not loaded yet');
    await goToHead();
    s = await until('HEAD selected', (p) => p.selected === main);
    assert.ok(s.commits > FIRST_PAGE, 'more history loaded');
    assert.ok(inView(s, main), 'HEAD row in view');
  });

  it('offers to add the branch to the filter when the filter leaves HEAD out', async () => {
    await filter('refs/heads/feature/login');
    ui.click('Show main Too');
    await goToHead();
    const s = await until('HEAD selected', (p) => p.selected === git('rev-parse', 'main'));
    assert.match(ui.first('notify').message, /HEAD \(main\) is not in the graph/);
    assert.deepEqual(s.options.refs, ['refs/heads/feature/login', 'refs/heads/main']);
  });

  it('loads further history under a branch filter when the filter reaches HEAD', async () => {
    const main = git('rev-parse', 'main');
    longBranch('strata-long', FIRST_PAGE + 100, main);
    // A selection the filtered history has near its top, which the reload finds at once.
    await reloadAndSelectTip(panel(), 'strata-long');
    let s = await filter('refs/heads/strata-long', false);
    assert.ok(s.commits <= FIRST_PAGE && !s.done, 'HEAD is not loaded yet');
    await goToHead();
    s = await until('HEAD selected', (p) => p.selected === main);
    assert.ok(s.commits > FIRST_PAGE, 'more history loaded');
    assert.equal(ui.of('notify').length, 0);
  });

  it('says at once when the filter leaves HEAD out, loading no history to look for it', async () => {
    longBranch('strata-lone', FIRST_PAGE + 100);
    // A selection the filtered history has near its top, which the reload finds at once.
    await reloadAndSelectTip(panel(), 'strata-lone');
    let s = await filter('refs/heads/strata-lone', false);
    const loaded = s.commits;
    assert.ok(!s.done, 'more history to load');
    await goToHead();
    await waitFor('told', () => ui.of('notify').length > 0);
    assert.match(ui.first('notify').message, /HEAD \(main\) is not in the graph/);
    s = await panel().probe();
    assert.equal(s.commits, loaded, 'no history loaded to look for HEAD');
    assert.equal(s.announced, 'HEAD is not in the graph: the branch filter leaves it out');
  });

  it('goes to a detached HEAD, also from the command palette', async () => {
    const at = git('rev-parse', 'feature/search');
    await gitRetry('checkout', '--quiet', '--detach', at);
    await reload(panel());
    await run('strata.goToHead');
    const s = await until('detached HEAD selected', (p) => p.selected === at);
    assert.ok(inView(s, at), 'HEAD row in view');
  });
});
