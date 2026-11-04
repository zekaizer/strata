import type { Commit } from './commit.ts';

/** Lane assignment carried from one page to the next. Plain data: crosses the worker boundary. */
export interface LaneState {
  /** Per lane, the commit hash the lane is waiting for, or null when free. */
  lanes: (string | null)[];
  /** Per lane, its color index. Meaningless for free lanes. */
  colors: number[];
  /** Next color index in rotation. */
  nextColor: number;
}

/** A line end at `lane`, drawn in `color`. */
export interface Edge {
  lane: number;
  color: number;
}

/**
 * Graph geometry of one commit row. The node sits at the vertical center of
 * the row in column `lane`.
 */
export interface Row {
  lane: number;
  color: number;
  /** Vertical lines crossing the row from top to bottom in the same column. */
  passes: Edge[];
  /** Lines from the top of the row at `lane` into the node (children above). */
  incoming: Edge[];
  /** Lines from the node to the bottom of the row at `lane` (towards parents). */
  outgoing: Edge[];
}

export interface LayoutOptions {
  /** Number of distinct lane colors. */
  colors: number;
}

export type LayoutCommit = Pick<Commit, 'hash' | 'parents'>;

export function initialLaneState(): LaneState {
  return { lanes: [], colors: [], nextColor: 0 };
}

/**
 * Lays out one page of commits given the state left by the previous page.
 * Commits must arrive children-before-parents (git --date-order/--topo-order).
 * Columns never shift: a lane keeps its column until the commit it waits for
 * arrives, and freed columns are reused. Pure: `state` is not modified.
 */
export function layoutPage(
  state: LaneState,
  commits: readonly LayoutCommit[],
  opts: LayoutOptions = { colors: 8 },
): { rows: Row[]; state: LaneState } {
  const lanes = [...state.lanes];
  const colors = [...state.colors];
  let nextColor = state.nextColor;
  const rows: Row[] = [];

  /**
   * Next color in rotation that differs from the lanes beside `lane` and from
   * `avoid`. When the palette is too small for both, neighbours win.
   */
  const pickColor = (lane: number, avoid: number[]): number => {
    const neighbours = new Set<number>();
    for (const n of [lane - 1, lane + 1]) {
      if (lanes[n] != null) neighbours.add(colors[n]!);
    }
    for (const exclude of [new Set([...neighbours, ...avoid]), neighbours]) {
      for (let k = 0; k < opts.colors; k++) {
        const c = (nextColor + k) % opts.colors;
        if (!exclude.has(c)) {
          nextColor = (c + 1) % opts.colors;
          return c;
        }
      }
    }
    const c = nextColor;
    nextColor = (nextColor + 1) % opts.colors;
    return c;
  };

  /** First free column at or after `from`, else a new column on the right. */
  const freeLane = (from: number): number => {
    for (let i = from; i < lanes.length; i++) if (lanes[i] == null) return i;
    return lanes.length;
  };

  for (const commit of commits) {
    const incoming: Edge[] = [];
    let lane = -1;
    lanes.forEach((h, i) => {
      if (h !== commit.hash) return;
      incoming.push({ lane: i, color: colors[i]! });
      if (lane < 0) lane = i;
    });

    // Lanes converging into this commit end here; the node keeps the leftmost.
    for (const e of incoming) lanes[e.lane] = null;
    let color: number;
    if (lane < 0) {
      lane = freeLane(0);
      color = pickColor(lane, []);
    } else {
      color = colors[lane]!;
    }

    const passes: Edge[] = [];
    lanes.forEach((h, i) => {
      if (h != null) passes.push({ lane: i, color: colors[i]! });
    });

    const outgoing: Edge[] = [];
    const parents = [...new Set(commit.parents)];
    parents.forEach((p, k) => {
      if (k === 0) {
        lanes[lane] = p;
        colors[lane] = color;
        outgoing.push({ lane, color });
        return;
      }
      const waiting = lanes.indexOf(p);
      if (waiting >= 0 && waiting !== lane) {
        outgoing.push({ lane: waiting, color: colors[waiting]! });
        return;
      }
      const l = freeLane(lane + 1);
      const c = pickColor(
        l,
        outgoing.map((e) => e.color),
      );
      lanes[l] = p;
      colors[l] = c;
      outgoing.push({ lane: l, color: c });
    });

    rows.push({ lane, color, passes, incoming, outgoing });
    while (lanes.length > 0 && lanes[lanes.length - 1] == null) {
      lanes.pop();
      colors.pop();
    }
  }

  return { rows, state: { lanes, colors: colors.slice(0, lanes.length), nextColor } };
}
