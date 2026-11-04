import type { Row, SpanIndex } from '../core/layout.ts';
import type { GraphTheme } from './theme.ts';

export const ROW_HEIGHT = 24;
export const LANE_WIDTH = 14;
export const GRAPH_PADDING = 8;

export const laneX = (lane: number) => GRAPH_PADDING + lane * LANE_WIDTH + LANE_WIDTH / 2;

/** Width in CSS pixels needed to show `lanes` columns. */
export const graphWidth = (lanes: number) => GRAPH_PADDING * 2 + Math.max(1, lanes) * LANE_WIDTH;

/** Highest column a row's node or its own lines use, plus one. */
export function rowWidth(row: Row): number {
  let w = row.lane;
  for (const e of row.incoming) w = Math.max(w, e.lane);
  for (const e of row.outgoing) w = Math.max(w, e.lane);
  return w + 1;
}

export interface NodeStyle {
  head: boolean;
  merge: boolean;
}

/**
 * Draws rows [first, last) into a canvas that covers the visible graph column.
 * `ctx` is already scaled to CSS pixels; row i's top edge is at i*ROW_HEIGHT - scrollTop.
 */
export function drawGraph(
  ctx: CanvasRenderingContext2D,
  rows: readonly Row[],
  spans: SpanIndex,
  first: number,
  last: number,
  scrollTop: number,
  theme: GraphTheme,
  style: (index: number) => NodeStyle,
): void {
  const color = (c: number) => theme.lanes[c % theme.lanes.length]!;
  const end = Math.min(last, rows.length);
  ctx.lineWidth = theme.lineWidth;
  ctx.lineCap = 'round';

  for (let i = first; i < end; i++) {
    const row = rows[i]!;
    const top = i * ROW_HEIGHT - scrollTop;
    const mid = top + ROW_HEIGHT / 2;
    const bottom = top + ROW_HEIGHT;
    const x = laneX(row.lane);

    for (const e of spans.passesAt(i)) {
      stroke(ctx, color(e.color), (c) => {
        c.moveTo(laneX(e.lane), top);
        c.lineTo(laneX(e.lane), bottom);
      });
    }
    for (const e of row.incoming) {
      const xe = laneX(e.lane);
      stroke(ctx, color(e.color), (c) => {
        c.moveTo(xe, top);
        // Vertical tangents at both ends give an S-curve between columns.
        if (xe === x) c.lineTo(x, mid);
        else c.bezierCurveTo(xe, mid, x, top, x, mid);
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
  }

  // Nodes last so lines never cover them.
  for (let i = first; i < end; i++) {
    const row = rows[i]!;
    const x = laneX(row.lane);
    const y = i * ROW_HEIGHT - scrollTop + ROW_HEIGHT / 2;
    const { head, merge } = style(i);
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
