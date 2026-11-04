import * as assert from 'node:assert/strict';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import type { Commit } from '../../src/core/commit.ts';
import { initialLaneState, layoutPage, SpanIndex, type Row } from '../../src/core/layout.ts';
import { anchoredAt, interleave, type StashEntry } from '../../src/core/stash.ts';
import { lanesUsed } from '../../src/webview/lanes.ts';
import { scenarios, type ScenarioName } from '../fixtures/scenarios.ts';
import { git, tempDir } from './helpers.ts';

describe('stash rows and the graph width', () => {
  const root = tempDir('lanes');
  const names: ScenarioName[] = ['branchy', 'octopus', 'multi-root', 'large'];
  const histories = new Map<ScenarioName, { commits: Commit[]; rows: Row[]; spans: SpanIndex }>();

  before(() => {
    for (const n of names) {
      const dir = join(root, n);
      scenarios[n]().write(dir);
      const commits = git(dir, 'log', '--topo-order', '--format=%H %P', '--branches', '--remotes', 'HEAD')
        .split('\n')
        .map((l): Commit => {
          const [hash, ...parents] = l.split(' ');
          return { hash: hash!, parents, author: '', authorEmail: '', authorTime: 0, commitTime: 0, subject: '' };
        });
      const page = layoutPage(initialLaneState(), commits);
      const spans = new SpanIndex();
      spans.add(page.spans);
      spans.setOpen(page.state);
      histories.set(n, { commits, rows: page.rows, spans });
    }
  });

  /** A stash on every third commit, two on every ninth, and one displaced to the tip of every fifth. */
  const stashesOn = (commits: Commit[]): StashEntry[] =>
    commits.flatMap((c, i) => {
      const at = (n: number, anchor: StashEntry['anchor']): StashEntry => ({
        hash: `${c.hash}-${n}`,
        index: i * 3 + n,
        base: c.hash,
        untracked: undefined,
        message: 'On main: wip',
        branch: 'main',
        time: 0,
        autostash: false,
        anchor,
        files: undefined,
      });
      return [
        ...(i % 3 === 0 ? [at(0, { kind: 'base' })] : []),
        ...(i % 9 === 0 ? [at(1, { kind: 'base' })] : []),
        ...(i % 5 === 0 ? [at(2, { kind: 'tip', tip: c.hash })] : []),
      ];
    });

  for (const n of names) {
    it(`${n}: the whole history needs no more columns with stash rows than without`, () => {
      const { commits, rows, spans } = histories.get(n)!;
      const plain = interleave(commits, 0, new Map());
      const stashed = interleave(commits, 0, anchoredAt(stashesOn(commits)));
      assert.ok(stashed.length > plain.length);
      assert.equal(lanesUsed(stashed, rows, spans, 0, stashed.length), lanesUsed(plain, rows, spans, 0, plain.length));
    });

    it(`${n}: a stash row needs no more columns than the commit it is drawn above`, () => {
      const { commits, rows, spans } = histories.get(n)!;
      const list = interleave(commits, 0, anchoredAt(stashesOn(commits)));
      list.forEach((r, i) => {
        if (r.kind !== 'stash') return;
        const anchor = list.findIndex((a) => a.kind === 'commit' && a.row === r.row);
        assert.ok(
          lanesUsed(list, rows, spans, i, i + 1) <= lanesUsed(list, rows, spans, anchor, anchor + 1),
          `stash row ${i} above commit row ${r.row}`,
        );
      });
    });
  }
});
