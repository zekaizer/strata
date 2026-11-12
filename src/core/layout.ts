import type { Commit } from './commit.ts';

/** Lane assignment carried from one page to the next. Plain data: crosses the worker boundary. */
export interface LaneState {
  /** Per lane, the commit hash the lane is waiting for, or null when free. */
  lanes: (string | null)[];
  /** Per lane, its color index. Meaningless for free lanes. */
  colors: number[];
  /** Per lane, the row whose bottom edge the lane's current line starts at. Meaningless for free lanes. */
  since: number[];
  /** Index of the next row to lay out, counted from the first page. */
  row: number;
  /** Next color index in rotation. */
  nextColor: number;
  /**
   * The commit column 0 is held for: no node or line uses the column until it arrives. Null when
   * there is none, and from its arrival on.
   */
  head: string | null;
}

/** A line end at `lane`, drawn in `color`. */
export interface Edge {
  lane: number;
  color: number;
}

/**
 * Graph geometry of one commit row. The node sits at the vertical center of
 * the row in column `lane`. Lines that only pass through the row are not
 * stored per row; they come from {@link Span}s.
 */
export interface Row {
  lane: number;
  color: number;
  /** Lines from the top of the row at `lane` into the node (children above). */
  incoming: Edge[];
  /** Lines from the node to the bottom of the row at `lane` (towards parents). */
  outgoing: Edge[];
}

/**
 * A vertical line in column `lane` that crosses every row strictly between
 * `from` and `to`: it leaves row `from` at the bottom and enters row `to` at
 * the top. Storing lines this way keeps layout output proportional to the
 * number of commits rather than commits × graph width (hundreds of lanes on
 * the Linux kernel).
 */
export interface Span {
  lane: number;
  color: number;
  from: number;
  to: number;
}

export interface LayoutOptions {
  /** Number of distinct lane colors. */
  colors: number;
}

export type LayoutCommit = Pick<Commit, 'hash' | 'parents'>;

/**
 * The state before the first page. `head`: a commit that takes column 0 whenever it arrives, as its
 * first-parent line does after it. It must be one the history lists (see laneHead): the column is
 * left empty until it arrives.
 */
export function initialLaneState(head?: string): LaneState {
  return { lanes: [], colors: [], since: [], row: 0, nextColor: 0, head: head ?? null };
}

/**
 * Lays out one page of commits given the state left by the previous page.
 * Commits must arrive children-before-parents (git --topo-order/--date-order).
 * Columns never shift: a lane keeps its column until the commit it waits for
 * arrives, and freed columns are reused. `state.head` takes column 0 when it
 * arrives, from whichever columns waited for it. Returns the rows of the page and the
 * spans that ended in it; spans still open are described by the returned
 * state (see {@link openSpans}). Pure: `state` is not modified.
 */
export function layoutPage(
  state: LaneState,
  commits: readonly LayoutCommit[],
  opts: LayoutOptions = { colors: 8 },
): { rows: Row[]; spans: Span[]; state: LaneState } {
  const lanes = [...state.lanes];
  const colors = [...state.colors];
  const since = [...state.since];
  let nextColor = state.nextColor;
  let rowIndex = state.row;
  let head = state.head;
  const rows: Row[] = [];
  const spans: Span[] = [];

  /** Lanes waiting for each commit, ascending. */
  const waiting = new Map<string, number[]>();
  const wait = (hash: string, lane: number) => {
    const list = waiting.get(hash);
    if (!list) waiting.set(hash, [lane]);
    else {
      list.push(lane);
      list.sort((a, b) => a - b);
    }
  };
  lanes.forEach((h, i) => {
    if (h != null) wait(h, i);
  });

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

  /** First free column at or after `from`, else a new column on the right; not column 0 while it is held. */
  const freeLane = (from: number): number => {
    const first = head === null ? from : Math.max(from, 1);
    for (let i = first; i < lanes.length; i++) if (lanes[i] == null) return i;
    return Math.max(lanes.length, first);
  };

  const open = (lane: number, hash: string, color: number) => {
    // Free columns are null, not holes - the state is compared and cloned as plain data.
    while (lanes.length < lane) {
      lanes.push(null);
      colors.push(0);
      since.push(0);
    }
    lanes[lane] = hash;
    colors[lane] = color;
    since[lane] = rowIndex;
    wait(hash, lane);
  };

  for (const commit of commits) {
    const arriving = waiting.get(commit.hash) ?? [];
    waiting.delete(commit.hash);
    const incoming: Edge[] = arriving.map((l) => ({ lane: l, color: colors[l]! }));

    // Lanes converging into this commit end here; the node keeps the leftmost, or column 0 as HEAD.
    for (const l of arriving) {
      if (rowIndex - since[l]! >= 2) spans.push({ lane: l, color: colors[l]!, from: since[l]!, to: rowIndex });
      lanes[l] = null;
    }
    const from = arriving[0];
    const isHead = commit.hash === head;
    if (isHead) head = null;
    const lane = isHead ? 0 : (from ?? freeLane(0));
    const color = from === undefined ? pickColor(lane, []) : colors[from]!;

    const outgoing: Edge[] = [];
    const parents = [...new Set(commit.parents)];
    parents.forEach((p, k) => {
      if (k === 0) {
        open(lane, p, color);
        outgoing.push({ lane, color });
        return;
      }
      const joined = waiting.get(p)?.find((l) => l !== lane);
      if (joined !== undefined) {
        outgoing.push({ lane: joined, color: colors[joined]! });
        return;
      }
      const l = freeLane(lane + 1);
      const c = pickColor(
        l,
        outgoing.map((e) => e.color),
      );
      open(l, p, c);
      outgoing.push({ lane: l, color: c });
    });

    rows.push({ lane, color, incoming, outgoing });
    rowIndex++;
    while (lanes.length > 0 && lanes[lanes.length - 1] == null) {
      lanes.pop();
      colors.pop();
      since.pop();
    }
  }

  return {
    rows,
    spans,
    state: {
      lanes,
      colors: colors.slice(0, lanes.length),
      since: since.slice(0, lanes.length),
      row: rowIndex,
      nextColor,
      head,
    },
  };
}

/** Finds the lines passing through a row among many spans; rows are bucketed so lookups stay local. */
export class SpanIndex {
  private static readonly BUCKET = 256;
  private readonly buckets = new Map<number, Span[]>();
  private open: Span[] = [];

  add(spans: readonly Span[]): void {
    for (const s of spans) {
      const first = Math.floor((s.from + 1) / SpanIndex.BUCKET);
      const last = Math.floor((s.to - 1) / SpanIndex.BUCKET);
      for (let b = first; b <= last; b++) {
        const list = this.buckets.get(b);
        if (list) list.push(s);
        else this.buckets.set(b, [s]);
      }
    }
  }

  /** Replaces the open lines with those of `state`. They pass through every row after their start. */
  setOpen(state: LaneState): void {
    this.open = [];
    state.lanes.forEach((h, lane) => {
      if (h != null) this.open.push({ lane, color: state.colors[lane]!, from: state.since[lane]!, to: Infinity });
    });
  }

  /** Lines crossing `row` from top to bottom, by column. */
  passesAt(row: number): Edge[] {
    const out: Edge[] = [];
    for (const s of [...(this.buckets.get(Math.floor(row / SpanIndex.BUCKET)) ?? []), ...this.open]) {
      if (s.from < row && row < s.to) out.push({ lane: s.lane, color: s.color });
    }
    return out.sort((a, b) => a.lane - b.lane);
  }

  clear(): void {
    this.buckets.clear();
    this.open = [];
  }
}
