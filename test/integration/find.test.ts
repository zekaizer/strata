import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { ProbeState } from '../../src/shared/protocol.ts';
import { flowSuite, reload, run } from './flow-helpers.ts';
import { git, waitFor, workspaceRoot } from './helpers.ts';

/** First page of history the graph loads (main.ts FIRST_PAGE). */
const FIRST_PAGE = 300;

describe('find commits', () => {
  const { panel, ui } = flowSuite();
  const until = (what: string, test: (s: ProbeState) => boolean) =>
    waitFor(what, async () => {
      const s = await panel().probe();
      return test(s) && s;
    });
  const type = async (text: string) => {
    await panel().simulate({ kind: 'type', selector: '.find-input', text });
  };
  const key = (k: string, shiftKey = false) => panel().simulate({ kind: 'key', key: k, target: 'focused', shiftKey });
  const open = async () => {
    await panel().simulate({ kind: 'click', selector: '.find-button' });
    return until('find widget open', (s) => s.find.open && /find-input/.test(s.focused));
  };
  /** What git finds in the whole view, newest first. */
  const expected = (...filter: string[]) =>
    git('rev-list', '--topo-order', '-i', '-F', ...filter, '--branches', '--remotes', 'HEAD').split('\n');
  /** Writes `count` commits on `branch` on top of `from`, newer than the rest. */
  const longBranch = (branch: string, count: number, from: string) => {
    const start = Math.floor(Date.now() / 1000) + 1000;
    const stream = Array.from(
      { length: count },
      (_, i) =>
        `commit refs/heads/${branch}\ncommitter Ada Lovelace <ada@example.com> ${start + i} +0000\ndata 6\nlong ${i % 10}\n${i === 0 ? `from ${from}\n` : ''}\n`,
    ).join('');
    execFileSync('git', ['fast-import', '--quiet'], { cwd: workspaceRoot(), input: stream });
  };

  afterEach(async () => {
    if ((await panel().probe()).find.open) await key('Escape');
    if ((await panel().probe()).options.refs !== null) {
      await panel().simulate({ kind: 'click', selector: '.ref-filter-button' });
      await panel().simulate({ kind: 'click', selector: '.popover-all' });
      await panel().simulate({ kind: 'key', key: 'Escape' });
    }
  });

  it('marks the matching commits and branches, and goes to the first one', async () => {
    await open();
    await type('search');
    const hits = expected('--grep=search');
    const s = await until('matches counted', (p) => p.find.count === `1 of ${hits.length}`);
    assert.equal(s.selected, hits[0]);
    const rows = Object.entries(s.rowHashes)
      .filter(([, h]) => hits.includes(h))
      .map(([i]) => Number(i));
    assert.deepEqual(
      s.find.hitRows.sort((a, b) => a - b),
      rows.sort((a, b) => a - b),
    );
    assert.ok(Object.values(s.find.marks).flat().length > 0);
    assert.ok(
      Object.values(s.find.marks)
        .flat()
        .every((m) => m.toLowerCase() === 'search'),
    );
    assert.deepEqual(s.find.badges, ['feature/search']);
  });

  it('steps through the matches with Enter and Shift+Enter, wrapping around', async () => {
    await open();
    await type('login');
    const hits = expected('--grep=login');
    assert.ok(hits.length >= 3);
    await until('first match', (p) => p.selected === hits[0]);
    await key('Enter');
    await until('second match', (p) => p.selected === hits[1] && p.find.count === `2 of ${hits.length}`);
    await key('Enter', true);
    await until('back to the first', (p) => p.selected === hits[0]);
    await key('Enter', true);
    await until('wrapped to the last', (p) => p.selected === hits.at(-1));
  });

  it('closes on Escape, unmarking the rows and keeping the selection', async () => {
    await open();
    await type('search');
    const s = await until('a match selected', (p) => p.find.matches > 0 && p.selected !== undefined);
    await key('Escape');
    const closed = await until('closed', (p) => !p.find.open);
    assert.deepEqual(closed.find.hitRows, []);
    assert.equal(closed.selected, s.selected);
    assert.match(closed.focused, /scroller/);
  });

  it('opens from Ctrl+F in the list and from Find Commit...', async () => {
    await panel().simulate({ kind: 'key', key: 'f', ctrlKey: true });
    await until('opened by Ctrl+F', (p) => p.find.open);
    await key('Escape');
    await until('closed', (p) => !p.find.open);
    await run('strata.find');
    await until('opened by the command', (p) => p.find.open && /find-input/.test(p.focused));
  });

  it('finds by author, and by author and text', async () => {
    await open();
    await type('author:ada');
    await until('every commit by Ada', (p) => p.find.count.endsWith(`of ${expected('--author=ada').length}`));
    await type('author:"ada lovelace" merge');
    const both = expected('--author=ada lovelace', '--grep=merge');
    // The first match at or below the selection is shown.
    await until(
      'Ada’s merges',
      (p) =>
        p.selected !== undefined &&
        both.includes(p.selected) &&
        p.find.count === `${both.indexOf(p.selected) + 1} of ${both.length}`,
    );
  });

  it('goes to a commit by its hash', async () => {
    const target = git('rev-parse', 'feature/login~1');
    await open();
    await type(target.slice(0, 8).toUpperCase());
    await until('the commit selected', (p) => p.selected === target && p.find.count === '1 of 1');
  });

  it('loads history down to a match not loaded yet', async () => {
    longBranch('strata-long', FIRST_PAGE + 2000, git('rev-parse', 'main'));
    await reload(panel());
    await panel().simulate({ kind: 'scrollToRow', index: 0 });
    await panel().simulate({ kind: 'clickRow', index: 0 });
    await reload(panel());
    let s = await until('first page', (p) => p.commits > 0 && !p.restoring);
    assert.ok(!s.done && s.commits <= FIRST_PAGE);
    await open();
    await type('login form');
    const [target] = expected('--grep=login form');
    await until('counted, not loaded', (p) => p.find.count === '? of 1');
    await key('Enter');
    s = await until('the match selected', (p) => p.selected === target);
    assert.ok(s.commits > FIRST_PAGE, 'more history loaded');
    assert.equal(s.find.count, '1 of 1');
    assert.equal(s.find.progress, false);
    assert.match(s.status, /commits$/);
    const row = Object.entries(s.rowHashes).find(([, h]) => h === target)?.[0];
    assert.ok(row !== undefined, 'its row is drawn');
  });

  it('stops going to a match on Escape', async () => {
    // Long enough that loading down to the match takes several pages.
    longBranch('strata-long', 20_000, git('rev-parse', 'main'));
    await reload(panel());
    await panel().simulate({ kind: 'scrollToRow', index: 0 });
    await panel().simulate({ kind: 'clickRow', index: 0 });
    await reload(panel());
    const before = await until('first page', (p) => p.commits > 0 && !p.restoring);
    await open();
    await type('login form');
    await until('counted', (p) => p.find.count === '? of 1');
    await key('Enter');
    await key('Escape');
    const s = await until('stopped', (p) => !p.find.progress && p.find.count === '? of 1');
    assert.equal(s.find.open, true, 'the first Escape only stops');
    assert.equal(s.selected, before.selected);
    assert.equal(s.restoring, false);
    assert.ok(!s.done);
  });

  it('searches again when the view changes', async () => {
    await open();
    await type('login');
    await until('all matches', (p) => p.find.count.endsWith(`of ${expected('--grep=login').length}`));
    await panel().simulate({ kind: 'click', selector: '.ref-filter-button' });
    await panel().simulate({ kind: 'click', selector: 'input[data-ref="refs/heads/wip/experiment"]' });
    await panel().simulate({ kind: 'key', key: 'Escape' });
    const view = git('rev-list', '--topo-order', '-i', '-F', '--grep=login', 'refs/heads/wip/experiment').split('\n');
    const s = await until('matches of the filtered view', (p) => p.find.matches === view.length && p.done);
    assert.equal(s.find.open, true);
    assert.equal(s.find.input, 'login');
  });

  it('offers to add a branch that reaches a commit the branch filter leaves out', async () => {
    await panel().simulate({ kind: 'click', selector: '.ref-filter-button' });
    await panel().simulate({ kind: 'click', selector: 'input[data-ref="refs/heads/wip/experiment"]' });
    await panel().simulate({ kind: 'key', key: 'Escape' });
    await until('filtered', (p) => p.options.refs !== null && p.done);
    const outside = git('rev-parse', 'cross/x');
    ui.click('Show cross/x Too');
    await open();
    await type(outside.slice(0, 7));
    await until('counted', (p) => p.find.count === '? of 1');
    await key('Enter');
    const s = await until('shown and selected', (p) => p.selected === outside);
    assert.equal(
      ui.first('notify').message,
      `Commit ${outside.slice(0, 7)} is not in the graph: the branch filter leaves it out.`,
    );
    assert.deepEqual(s.options.refs, ['refs/heads/wip/experiment', 'refs/heads/cross/x']);
  });

  it('says why a commit only a tag reaches is not in the graph', async () => {
    const stream = `commit refs/heads/strata-tmp\ncommitter Ada Lovelace <ada@example.com> 1700000000 +0000\ndata 7\nhotfix\nfrom ${git('rev-parse', 'main~1')}\n\n`;
    execFileSync('git', ['fast-import', '--quiet'], { cwd: workspaceRoot(), input: stream });
    git('tag', 'v9-hotfix', 'strata-tmp');
    git('branch', '-D', 'strata-tmp');
    const hotfix = git('rev-parse', 'v9-hotfix');
    await reload(panel());
    await open();
    await type(hotfix.slice(0, 7));
    await until('counted', (p) => p.find.count === '? of 1');
    await key('Enter');
    await until('not in view', (p) => p.find.count === 'Not in view');
    await waitFor('told', () => ui.of('notify').length > 0);
    assert.equal(
      ui.first('notify').message,
      `Commit ${hotfix.slice(0, 7)} is not in the graph: only tag v9-hotfix reaches it, and the graph starts from branches, not tags.`,
    );
    assert.deepEqual(ui.first('notify').actions, []);
  });
});
