import * as assert from 'node:assert/strict';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { initialLaneState, layoutPage, type LaneState, type LayoutCommit, type Row } from '../../src/core/layout.ts';
import { large, scenarios, type ScenarioName } from '../fixtures/scenarios.ts';
import { git, tempDir } from './helpers.ts';

const C = (hash: string, ...parents: string[]): LayoutCommit => ({ hash, parents });

function layoutAll(commits: readonly LayoutCommit[], pageSizes?: number[]) {
  let state: LaneState = initialLaneState();
  const rows: Row[] = [];
  let i = 0;
  for (const size of pageSizes ?? [commits.length]) {
    const page = layoutPage(state, commits.slice(i, i + size));
    rows.push(...page.rows);
    state = page.state;
    i += size;
  }
  assert.equal(i, commits.length);
  return { rows, state };
}

/**
 * Reconstructs parent edges purely from row geometry: follow each outgoing
 * line down its column through `passes` until a row takes it as `incoming`.
 */
function traceEdges(commits: readonly LayoutCommit[], rows: Row[]): Set<string> {
  const edges = new Set<string>();
  rows.forEach((row, i) => {
    for (const out of row.outgoing) {
      let j = i + 1;
      for (; j < rows.length; j++) {
        const r = rows[j]!;
        const inc = r.incoming.find((e) => e.lane === out.lane);
        if (inc) {
          assert.equal(inc.color, out.color, `color changes along ${commits[i]!.hash} -> ${commits[j]!.hash}`);
          edges.add(`${commits[i]!.hash}>${commits[j]!.hash}`);
          break;
        }
        const pass = r.passes.find((e) => e.lane === out.lane);
        assert.ok(pass, `line from ${commits[i]!.hash} lane ${out.lane} broken at row ${j}`);
        assert.equal(pass.color, out.color, `color changes along lane ${out.lane} at row ${j}`);
        assert.notEqual(r.lane, out.lane, `line passes through node of row ${j}`);
      }
      if (j === rows.length) edges.add(`${commits[i]!.hash}>…`);
    }
  });
  return edges;
}

function expectedEdges(commits: readonly LayoutCommit[]): Set<string> {
  const present = new Set(commits.map((c) => c.hash));
  return new Set(commits.flatMap((c) => [...new Set(c.parents)].map((p) => `${c.hash}>${present.has(p) ? p : '…'}`)));
}

/** Structural invariants of a single row. */
function checkRow(row: Row, i: number): void {
  const cols = [row.lane, ...row.passes.map((e) => e.lane)];
  assert.equal(new Set(cols).size, cols.length, `row ${i}: node overlaps a pass-through line`);
  const outs = row.outgoing.map((e) => e.lane);
  assert.equal(new Set(outs).size, outs.length, `row ${i}: two outgoing lines share a column`);
  // A merge line may join a lane that already waits for the same parent; it then shares its color.
  for (const o of row.outgoing) {
    const pass = row.passes.find((p) => p.lane === o.lane);
    if (pass) assert.equal(pass.color, o.color, `row ${i}: outgoing joins a different line at ${o.lane}`);
  }
  const ins = row.incoming.map((e) => e.lane);
  assert.equal(new Set(ins).size, ins.length, `row ${i}: two incoming lines share a column`);
  for (const n of ins) assert.ok(!row.passes.some((p) => p.lane === n), `row ${i}: incoming overlaps pass at ${n}`);
  for (const e of [...row.passes, ...row.incoming, ...row.outgoing]) assert.ok(e.lane >= 0 && e.color >= 0);
}

describe('layoutPage: hand-made histories', () => {
  it('puts a linear history in one lane', () => {
    const { rows, state } = layoutAll([C('c', 'b'), C('b', 'a'), C('a')]);
    assert.deepEqual(
      rows.map((r) => r.lane),
      [0, 0, 0],
    );
    assert.deepEqual(rows[0]!.incoming, []);
    assert.deepEqual(rows[2]!.outgoing, []);
    assert.deepEqual(state.lanes, []);
  });

  it('opens a lane for a branch and closes it at the fork point', () => {
    //  m   merge of x into main
    //  |\
    //  b |
    //  | x
    //  |/
    //  a
    const { rows } = layoutAll([C('m', 'b', 'x'), C('b', 'a'), C('x', 'a'), C('a')]);
    assert.deepEqual(
      rows.map((r) => r.lane),
      [0, 0, 1, 0],
    );
    assert.deepEqual(
      rows[0]!.outgoing.map((e) => e.lane),
      [0, 1],
    );
    assert.deepEqual(rows[3]!.incoming.map((e) => e.lane).sort(), [0, 1]);
  });

  it('draws an octopus merge with one outgoing line per parent', () => {
    const { rows } = layoutAll([
      C('o', 'a', 'b', 'c', 'd'),
      C('d', 'r'),
      C('c', 'r'),
      C('b', 'r'),
      C('a', 'r'),
      C('r'),
    ]);
    assert.equal(rows[0]!.outgoing.length, 4);
    assert.equal(new Set(rows[0]!.outgoing.map((e) => e.color)).size, 4, 'parents get distinct colors');
    assert.equal(rows[5]!.incoming.length, 4);
  });

  it('merges into a lane that already waits for the parent instead of opening one', () => {
    // t1 and t2 are tips; t2 merges t1's parent p which t1's lane already awaits.
    const { rows } = layoutAll([C('t1', 'p'), C('t2', 'q', 'p'), C('p', 'r'), C('q', 'r'), C('r')]);
    assert.deepEqual(rows[1]!.outgoing.map((e) => e.lane).sort(), [0, 1]);
    assert.ok(Math.max(...rows.flatMap((r) => [r.lane, ...r.outgoing.map((e) => e.lane)])) <= 1);
  });

  it('reuses a freed lane', () => {
    const { rows } = layoutAll([C('a2', 'a1'), C('a1'), C('b2', 'b1'), C('b1')]);
    assert.deepEqual(
      rows.map((r) => r.lane),
      [0, 0, 0, 0],
    );
  });

  it('ignores duplicate parents', () => {
    const { rows } = layoutAll([C('m', 'a', 'a'), C('a')]);
    assert.equal(rows[0]!.outgoing.length, 1);
  });

  it('keeps a line open for a parent outside the loaded history', () => {
    const { rows, state } = layoutAll([C('b', 'a'), C('a', 'missing')]);
    assert.equal(rows[1]!.outgoing.length, 1);
    assert.deepEqual(state.lanes, ['missing']);
  });

  it('does not modify the input state', () => {
    const s = layoutPage(initialLaneState(), [C('b', 'a')]).state;
    const copy = structuredClone(s);
    layoutPage(s, [C('a', 'z', 'y')]);
    assert.deepEqual(s, copy);
  });

  it('cycles colors within the palette size', () => {
    const tips = Array.from({ length: 20 }, (_, i) => C(`t${i}`, 'root'));
    const { rows } = layoutAll([...tips, C('root')]);
    for (const r of rows) assert.ok(r.color < 8);
  });

  it('gives a new lane a color different from its neighbours', () => {
    const tips = Array.from({ length: 12 }, (_, i) => C(`t${i}`, `p${i}`));
    const { rows } = layoutAll([...tips, ...tips.map((_, i) => C(`p${i}`))]);
    const colorAt = new Map(rows.slice(0, 12).map((r) => [r.lane, r.color]));
    for (const [lane, color] of colorAt) {
      assert.notEqual(colorAt.get(lane + 1), color, `lanes ${lane} and ${lane + 1}`);
    }
  });
});

describe('layoutPage: fixture repositories', () => {
  const root = tempDir('layout');
  const names: ScenarioName[] = ['linear', 'branchy', 'octopus', 'multi-root', 'refs', 'clock-skew', 'large'];
  const histories = new Map<ScenarioName, LayoutCommit[]>();
  const firstParent = new Map<ScenarioName, LayoutCommit[]>();
  const read = (dir: string, ...extra: string[]): LayoutCommit[] =>
    git(dir, 'log', '--date-order', '--format=%H %P', ...extra, '--branches', '--remotes', '--tags', 'HEAD')
      .split('\n')
      .map((l) => {
        const [hash, ...parents] = l.trim().split(' ');
        return { hash: hash!, parents: extra.length ? parents.slice(0, 1) : parents };
      });

  before(() => {
    for (const n of names) {
      const dir = join(root, n);
      scenarios[n]().write(dir);
      histories.set(n, read(dir));
      firstParent.set(n, read(dir, '--first-parent'));
    }
  });

  for (const n of names) {
    it(`${n}: row geometry reproduces exactly the parent edges`, () => {
      const commits = histories.get(n)!;
      const { rows } = layoutAll(commits);
      rows.forEach(checkRow);
      assert.deepEqual(traceEdges(commits, rows), expectedEdges(commits));
    });

    it(`${n}: first-parent history stays in one lane per root`, () => {
      const commits = firstParent.get(n)!;
      const { rows } = layoutAll(commits);
      assert.deepEqual(traceEdges(commits, rows), expectedEdges(commits));
    });
  }

  for (const n of ['branchy', 'octopus', 'multi-root', 'clock-skew'] as const) {
    it(`${n}: splitting into two pages at every boundary gives identical rows`, () => {
      const commits = histories.get(n)!;
      const whole = layoutAll(commits);
      for (let i = 0; i <= commits.length; i++) {
        assert.deepEqual(layoutAll(commits, [i, commits.length - i]), whole, `split at ${i}`);
      }
    });
  }

  it('octopus: a page boundary right after each octopus merge', () => {
    const commits = histories.get('octopus')!;
    const whole = layoutAll(commits);
    commits.forEach((c, i) => {
      if (c.parents.length < 3) return;
      assert.deepEqual(layoutAll(commits, [i + 1, commits.length - i - 1]), whole, `after ${c.hash}`);
      assert.deepEqual(layoutAll(commits, [i, commits.length - i]), whole, `before ${c.hash}`);
    });
  });

  it('large: page sizes 1, 7 and 100 match a single page', () => {
    const commits = histories.get('large')!;
    const whole = layoutAll(commits);
    for (const size of [1, 7, 100]) {
      const sizes = Array.from({ length: Math.ceil(commits.length / size) }, (_, k) =>
        Math.min(size, commits.length - k * size),
      );
      assert.deepEqual(layoutAll(commits, sizes), whole, `page size ${size}`);
    }
  });

  it('large: the state survives structured cloning between pages (worker boundary)', () => {
    const commits = histories.get('large')!;
    let state = initialLaneState();
    const rows: Row[] = [];
    for (let i = 0; i < commits.length; i += 250) {
      const page = layoutPage(structuredClone(state), commits.slice(i, i + 250));
      rows.push(...page.rows);
      state = page.state;
    }
    assert.deepEqual(rows, layoutAll(commits).rows);
  });

  it('large: width stays bounded', () => {
    const { rows } = layoutAll(histories.get('large')!);
    const width =
      Math.max(...rows.flatMap((r) => [r.lane, ...r.passes.map((e) => e.lane), ...r.outgoing.map((e) => e.lane)])) + 1;
    assert.ok(width <= 40, `width ${width}`);
  });
});

describe('layoutPage: color fallback', () => {
  const root = tempDir('layout-colors');
  it("never gives a newly opened lane a neighbour's color when a third color is free", () => {
    const dir = join(root, 'large');
    large(3000, 7).write(dir);
    const commits = git(dir, 'log', '--date-order', '--format=%H %P', '--branches', '--remotes', '--tags', 'HEAD')
      .split('\n')
      .map((l) => {
        const [hash, ...parents] = l.trim().split(' ');
        return { hash: hash!, parents };
      });
    const { rows } = layoutPage(initialLaneState(), commits, { colors: 3 });
    rows.forEach((row, i) => {
      const bottom = new Map([...row.passes, ...row.outgoing].map((e) => [e.lane, e.color]));
      const opened = row.outgoing.filter((e) => e.lane !== row.lane && !row.passes.some((p) => p.lane === e.lane));
      for (const e of opened) {
        for (const n of [e.lane - 1, e.lane + 1]) {
          assert.notEqual(bottom.get(n), e.color, `row ${i}: new lane ${e.lane} matches neighbour ${n}`);
        }
      }
    });
  });
});
