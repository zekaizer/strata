import type { Commit } from '../core/commit.ts';
import type { Edge, Row, SpanIndex } from '../core/layout.ts';
import type { ListRow } from '../core/stash.ts';
import type { GraphTheme } from './theme.ts';

export const ROW_HEIGHT = 24;
export const LANE_WIDTH = 14;
export const GRAPH_PADDING = 8;

export const laneX = (lane: number) => GRAPH_PADDING + lane * LANE_WIDTH + LANE_WIDTH / 2;

/** Width in CSS pixels needed to show `lanes` columns. */
export const graphWidth = (lanes: number) => GRAPH_PADDING * 2 + Math.max(1, lanes) * LANE_WIDTH;

export interface NodeStyle {
  head: boolean;
  merge: boolean;
}

/** Space opened under list row `after` (the inline commit details); lines crossing it are drawn through. */
export interface Gap {
  after: number;
  height: number;
}

/** Side of a stash's square node in CSS px. */
const STASH_NODE = 7;
/** How far a displaced stash's spine reaches below its node: it joins nothing. */
const DANGLING = ROW_HEIGHT / 4;

/** A stash's node sits in the gap left of the column of the commit its row is drawn above. */
const stashX = (anchor: Row) => laneX(anchor.lane) - LANE_WIDTH / 2;

type StashRow = Extract<ListRow, { kind: 'stash' }>;

/** A stash row whose dashed spine runs down into its base, the commit it is drawn above. */
const joined = (r: ListRow | undefined): r is StashRow => r?.kind === 'stash' && r.stash.anchor.kind !== 'tip';

/**
 * Draws list rows [first, last) into a canvas that covers the visible graph column.
 * `ctx` is already scaled to CSS pixels; `rowTop(i)` is list row i's top edge in
 * list coordinates, so it is drawn at rowTop(i) - scrollTop. `rows` is the layout,
 * indexed by commit; list rows whose commit is not laid out yet are left blank. A
 * row taller than ROW_HEIGHT has its commit line at the bottom (refs sit above it):
 * its node and curves are drawn there and incoming lines run straight down to it.
 * A stash row has no lane: the lines entering its anchor commit from above run
 * straight through it, and its square node sits in the gap left of the anchor's
 * column, where no line runs (see lanes.ts).
 */
export function drawGraph(
  ctx: CanvasRenderingContext2D,
  list: readonly ListRow[],
  rows: readonly Row[],
  spans: SpanIndex,
  first: number,
  last: number,
  scrollTop: number,
  theme: GraphTheme,
  style: (commit: Commit) => NodeStyle,
  rowTop: (index: number) => number,
  rowHeight: (index: number) => number,
  gap: Gap | undefined,
): void {
  const color = (c: number) => theme.lanes[c % theme.lanes.length]!;
  const stashColor = (r: StashRow) => (r.stash.autostash ? theme.stashWarning : theme.stash);
  const end = Math.min(last, list.length);
  ctx.lineWidth = theme.lineWidth;
  ctx.lineCap = 'round';
  const vertical = (e: Edge, top: number, bottom: number) => {
    stroke(ctx, color(e.color), (c) => {
      c.moveTo(laneX(e.lane), top);
      c.lineTo(laneX(e.lane), bottom);
    });
  };
  /** Dashed, with the dashes fixed to the list so they do not crawl while scrolling. */
  const spine = (r: StashRow, path: (c: CanvasRenderingContext2D) => void, from: number) => {
    ctx.save();
    ctx.setLineDash([2, 3]);
    ctx.lineDashOffset = from + scrollTop;
    stroke(ctx, stashColor(r), path);
    ctx.restore();
  };

  for (let i = first; i < end; i++) {
    const item = list[i]!;
    const row = rows[item.row];
    if (!row) continue;
    const top = rowTop(i) - scrollTop;
    const bottom = top + rowHeight(i);
    const lineTop = bottom - ROW_HEIGHT;
    const mid = lineTop + ROW_HEIGHT / 2;
    const x = laneX(row.lane);
    const sx = stashX(row);
    const above = i > 0 ? list[i - 1] : undefined;

    for (const e of spans.passesAt(item.row)) vertical(e, top, bottom);
    if (item.kind === 'stash') {
      for (const e of row.incoming) vertical(e, top, bottom);
      const half = STASH_NODE / 2;
      if (joined(above))
        spine(
          above,
          (c) => {
            c.moveTo(sx, top);
            c.lineTo(sx, mid - half);
          },
          top,
        );
      const stop = joined(item) ? bottom : mid + half + DANGLING;
      spine(
        item,
        (c) => {
          c.moveTo(sx, mid + half);
          c.lineTo(sx, stop);
        },
        mid + half,
      );
      continue;
    }
    for (const e of row.incoming) {
      const xe = laneX(e.lane);
      stroke(ctx, color(e.color), (c) => {
        c.moveTo(xe, top);
        c.lineTo(xe, lineTop);
        // Vertical tangents at both ends give an S-curve between columns.
        if (xe === x) c.lineTo(x, mid);
        else c.bezierCurveTo(xe, mid, x, lineTop, x, mid);
      });
    }
    for (const e of row.outgoing) {
      const xo = laneX(e.lane);
      stroke(ctx, color(e.color), (c) => {
        c.moveTo(x, mid);
        if (xo === x) c.lineTo(x, bottom);
        else c.bezierCurveTo(x, bottom, xo, mid, xo, bottom);
      });
    }
    // The spine of the stash above hooks into the node from the upper left, where no line enters.
    if (joined(above))
      spine(
        above,
        (c) => {
          c.moveTo(sx, top);
          c.lineTo(sx, lineTop);
          c.quadraticCurveTo(sx, mid, x, mid);
        },
        top,
      );
  }

  // Lines leaving the row above the gap continue straight through it to the row below.
  const above = gap && gap.after >= first && gap.after < end ? list[gap.after] : undefined;
  const aboveRow = above && rows[above.row];
  if (gap && above && aboveRow) {
    const top = rowTop(gap.after) + rowHeight(gap.after) - scrollTop;
    const leaving = above.kind === 'commit' ? aboveRow.outgoing : aboveRow.incoming;
    for (const e of [...spans.passesAt(above.row), ...leaving]) vertical(e, top, top + gap.height);
    if (joined(above))
      spine(
        above,
        (c) => {
          c.moveTo(stashX(aboveRow), top);
          c.lineTo(stashX(aboveRow), top + gap.height);
        },
        top,
      );
  }

  // Nodes last so lines never cover them.
  for (let i = first; i < end; i++) {
    const item = list[i]!;
    const row = rows[item.row];
    if (!row) continue;
    const x = laneX(row.lane);
    const y = rowTop(i) + rowHeight(i) - ROW_HEIGHT / 2 - scrollTop;
    if (item.kind === 'stash') {
      ctx.strokeStyle = stashColor(item);
      ctx.strokeRect(stashX(row) - STASH_NODE / 2, y - STASH_NODE / 2, STASH_NODE, STASH_NODE);
      continue;
    }
    const { head, merge } = style(item.commit);
    const r = theme.nodeRadius;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (merge) {
      // Punch out the line underneath so the row background shows through the hollow node.
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = color(row.color);
      ctx.stroke();
    } else {
      ctx.fillStyle = color(row.color);
      ctx.fill();
    }
    if (head) {
      ctx.beginPath();
      ctx.arc(x, y, r + 2.5, 0, Math.PI * 2);
      ctx.strokeStyle = theme.headRing;
      ctx.stroke();
    }
  }
}

function stroke(ctx: CanvasRenderingContext2D, color: string, path: (c: CanvasRenderingContext2D) => void): void {
  ctx.beginPath();
  path(ctx);
  ctx.strokeStyle = color;
  ctx.stroke();
}
