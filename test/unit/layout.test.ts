import * as assert from 'node:assert/strict';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import {
  initialLaneState,
  layoutPage,
  SpanIndex,
  type Edge,
  type LaneState,
  type LayoutCommit,
  type Row,
  type Span,
} from '../../src/core/layout.ts';
import { large, scenarios, type ScenarioName } from '../fixtures/scenarios.ts';
import { git, tempDir } from './helpers.ts';

const C = (hash: string, ...parents: string[]): LayoutCommit => ({ hash, parents });

/** A row with its pass-through lines, reconstructed from spans the way the renderer does. */
type FullRow = Row & { passes: Edge[] };

function withPasses(rows: readonly Row[], spans: readonly Span[], state: LaneState): FullRow[] {
  const index = new SpanIndex();
  index.add(spans);
  index.setOpen(state);
  return rows.map((r, i) => ({ ...r, passes: index.passesAt(i) }));
}

function layoutAll(commits: readonly LayoutCommit[], pageSizes?: number[], opts?: { colors: number }, head?: string) {
  let state: LaneState = initialLaneState(head);
  const rows: Row[] = [];
  const spans: Span[] = [];
  let i = 0;
  for (const size of pageSizes ?? [commits.length]) {
    const page = layoutPage(state, commits.slice(i, i + size), opts);
    rows.push(...page.rows);
    spans.push(...page.spans);
    state = page.state;
    i += size;
  }
  assert.equal(i, commits.length);
  return { rows: withPasses(rows, spans, state), state };
}

/**
 * Reconstructs parent edges purely from row geometry: follow each outgoing
 * line down its column through `passes` until a row takes it as `incoming`.
 */
function traceEdges(commits: readonly LayoutCommit[], rows: FullRow[]): Set<string> {
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
function checkRow(row: FullRow, i: number): void {
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

/** Every column a row's node and lines touch. */
const columns = (row: FullRow): number[] => [
  row.lane,
  ...[...row.incoming, ...row.outgoing, ...row.passes].map((e) => e.lane),
];

/** `head` and its first-parent line sit in column 0, which nothing uses above `head`. */
function checkHeadColumn(commits: readonly LayoutCommit[], rows: FullRow[], head: string): void {
  const index = new Map(commits.map((c, i) => [c.hash, i]));
  const at = index.get(head)!;
  for (let i = 0; i < at; i++) assert.ok(!columns(rows[i]!).includes(0), `row ${i} uses column 0 above HEAD`);
  assert.ok(!rows[at]!.incoming.some((e) => e.lane === 0), 'a line enters HEAD in column 0');
  for (let i: number | undefined = at; i !== undefined; i = index.get(commits[i]!.parents[0] ?? '')) {
    assert.equal(rows[i]!.lane, 0, `${commits[i]!.hash} on HEAD's first-parent line`);
  }
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

describe('layoutPage: column 0 held for HEAD', () => {
  const lanes = (commits: LayoutCommit[], head?: string) =>
    layoutAll(commits, undefined, undefined, head).rows.map((r) => r.lane);

  it('keeps HEAD and its first parents in column 0 when another branch is newer', () => {
    //  | x2      another branch, newer than HEAD
    //  | x1
    //  h |       HEAD
    //  |/
    //  a
    const commits = [C('x2', 'x1'), C('x1', 'a'), C('h', 'a'), C('a')];
    assert.deepEqual(lanes(commits), [0, 0, 1, 0], 'arrival order without a HEAD');
    const { rows } = layoutAll(commits, undefined, undefined, 'h');
    assert.deepEqual(
      rows.map((r) => r.lane),
      [1, 1, 0, 0],
    );
    assert.deepEqual(rows[3]!.incoming.map((e) => e.lane).sort(), [0, 1]);
    checkHeadColumn(commits, rows, 'h');
  });

  it('bends a branch built on HEAD into column 0 at HEAD, keeping its color', () => {
    const commits = [C('f2', 'f1'), C('f1', 'h'), C('h', 'a'), C('a')];
    const { rows } = layoutAll(commits, undefined, undefined, 'h');
    assert.deepEqual(
      rows.map((r) => r.lane),
      [1, 1, 0, 0],
    );
    assert.deepEqual(rows[2]!.incoming, [{ lane: 1, color: rows[1]!.color }]);
    assert.equal(rows[2]!.color, rows[1]!.color);
    rows.forEach(checkRow);
    assert.deepEqual(traceEdges(commits, rows), expectedEdges(commits));
  });

  it('takes column 0 for HEAD when several lines wait for it, one of them a merge line', () => {
    const commits = [C('f', 'h'), C('m', 'b', 'h'), C('b', 'a'), C('h', 'a'), C('a')];
    const { rows } = layoutAll(commits, undefined, undefined, 'h');
    assert.deepEqual(
      rows.map((r) => r.lane),
      [1, 2, 2, 0, 0],
    );
    assert.deepEqual(
      rows[3]!.incoming.map((e) => e.lane),
      [1],
      'the merge line joined the lane already waiting',
    );
    rows.forEach(checkRow);
    assert.deepEqual(traceEdges(commits, rows), expectedEdges(commits));
    checkHeadColumn(commits, rows, 'h');
  });

  it('takes column 0 for HEAD when lanes in several columns converge on it', () => {
    const commits = [C('f', 'h'), C('g', 'h'), C('h', 'a'), C('a')];
    const { rows } = layoutAll(commits, undefined, undefined, 'h');
    assert.deepEqual(
      rows.map((r) => r.lane),
      [1, 2, 0, 0],
    );
    assert.deepEqual(
      rows[2]!.incoming.map((e) => e.lane),
      [1, 2],
    );
    assert.equal(rows[2]!.color, rows[0]!.color, 'the leftmost line keeps its color through HEAD');
    rows.forEach(checkRow);
    assert.deepEqual(traceEdges(commits, rows), expectedEdges(commits));
  });

  it('opens the other parents of a HEAD that is an octopus merge to its right', () => {
    const commits = [C('t', 'r'), C('h', 'a', 'b', 'c'), C('c', 'r'), C('b', 'r'), C('a', 'r'), C('r')];
    const { rows } = layoutAll(commits, undefined, undefined, 'h');
    assert.equal(rows[1]!.lane, 0);
    assert.deepEqual(
      rows[1]!.outgoing.map((e) => e.lane),
      [0, 2, 3],
    );
    assert.equal(rows[4]!.lane, 0, 'the first parent');
    checkHeadColumn(commits, rows, 'h');
  });

  it('lays out a HEAD that is the newest commit as without one', () => {
    const commits = [C('h', 'b', 'x'), C('b', 'a'), C('x', 'a'), C('a')];
    assert.deepEqual(layoutAll(commits, undefined, undefined, 'h').rows, layoutAll(commits).rows);
  });

  it('holds no column without a HEAD (unborn branch)', () => {
    assert.equal(initialLaneState().head, null);
    assert.equal(lanes([C('b', 'a'), C('a')])[0], 0);
  });

  it('frees column 0 once the line of HEAD ends at a root', () => {
    const commits = [C('x', 'y'), C('h'), C('y')];
    assert.deepEqual(lanes(commits, 'h'), [1, 0, 1]);
    assert.deepEqual(lanes([...commits, C('z')], 'h'), [1, 0, 1, 0]);
  });

  it('holds the column across pages until HEAD arrives, and no longer', () => {
    const first = layoutPage(initialLaneState('h'), [C('x2', 'x1')]);
    assert.equal(first.state.head, 'h');
    assert.deepEqual(first.state.lanes, [null, 'x1']);
    const second = layoutPage(structuredClone(first.state), [C('x1', 'a'), C('h', 'a')]);
    assert.deepEqual(
      second.rows.map((r) => r.lane),
      [1, 0],
    );
    assert.equal(second.state.head, null);
    assert.deepEqual(second.state.lanes, ['a', 'a']);
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

  for (const n of ['branchy', 'octopus', 'multi-root', 'refs', 'clock-skew'] as const) {
    it(`${n}: any commit as HEAD takes column 0 with its first parents, edges intact, at every page boundary`, () => {
      const commits = histories.get(n)!;
      for (const { hash } of commits) {
        const whole = layoutAll(commits, undefined, undefined, hash);
        whole.rows.forEach(checkRow);
        assert.deepEqual(traceEdges(commits, whole.rows), expectedEdges(commits), hash);
        checkHeadColumn(commits, whole.rows, hash);
        assert.equal(whole.state.head, null);
        for (let i = 0; i <= commits.length; i++) {
          assert.deepEqual(layoutAll(commits, [i, commits.length - i], undefined, hash), whole, `split at ${i}`);
        }
      }
    });

    it(`${n}: any commit of the first-parent history as HEAD takes column 0`, () => {
      const commits = firstParent.get(n)!;
      for (const { hash } of commits) {
        const { rows } = layoutAll(commits, undefined, undefined, hash);
        assert.deepEqual(traceEdges(commits, rows), expectedEdges(commits), hash);
        checkHeadColumn(commits, rows, hash);
      }
    });
  }

  it('large: a HEAD deep in the history takes column 0 at page sizes 1, 7 and 100, and across the worker boundary', () => {
    const commits = histories.get('large')!;
    for (const at of [0, 1, 250, 2500, commits.length - 1]) {
      const head = commits[at]!.hash;
      const whole = layoutAll(commits, undefined, undefined, head);
      whole.rows.forEach(checkRow);
      assert.deepEqual(traceEdges(commits, whole.rows), expectedEdges(commits));
      checkHeadColumn(commits, whole.rows, head);
      for (const size of [1, 7, 100]) {
        const sizes = Array.from({ length: Math.ceil(commits.length / size) }, (_, k) =>
          Math.min(size, commits.length - k * size),
        );
        assert.deepEqual(layoutAll(commits, sizes, undefined, head), whole, `page size ${size}`);
      }
      let state = initialLaneState(head);
      const rows: Row[] = [];
      const spans: Span[] = [];
      for (let i = 0; i < commits.length; i += 250) {
        const page = structuredClone(layoutPage(structuredClone(state), commits.slice(i, i + 250)));
        rows.push(...page.rows);
        spans.push(...page.spans);
        state = page.state;
      }
      assert.deepEqual(withPasses(rows, spans, state), whole.rows);
    }
  });

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
    const spans: Span[] = [];
    for (let i = 0; i < commits.length; i += 250) {
      const page = structuredClone(layoutPage(structuredClone(state), commits.slice(i, i + 250)));
      rows.push(...page.rows);
      spans.push(...page.spans);
      state = page.state;
    }
    assert.deepEqual(withPasses(rows, spans, state), layoutAll(commits).rows);
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
    const { rows } = layoutAll(commits, undefined, { colors: 3 });
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
