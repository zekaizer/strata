import type { Row, SpanIndex } from '../core/layout.ts';
import type { ListRow } from '../core/stash.ts';

/** Highest column a row's node or its own lines use, plus one. */
export function rowWidth(row: Row): number {
  let w = row.lane;
  for (const e of row.incoming) w = Math.max(w, e.lane);
  for (const e of row.outgoing) w = Math.max(w, e.lane);
  return w + 1;
}

/**
 * Columns list rows [first, last) need. A stash row draws only the lines that enter its anchor
 * row from above and a node in the gap left of the anchor's column.
 */
export function lanesUsed(
  list: readonly ListRow[],
  rows: readonly Row[],
  spans: SpanIndex,
  first: number,
  last: number,
): number {
  let lanes = 1;
  for (let i = first; i < Math.min(last, list.length); i++) {
    const item = list[i]!;
    const row = rows[item.row];
    if (!row) continue;
    lanes = Math.max(lanes, item.kind === 'commit' ? rowWidth(row) : enteringWidth(row));
    for (const e of spans.passesAt(item.row)) lanes = Math.max(lanes, e.lane + 1);
  }
  return lanes;
}

/** Highest column of the node and of the lines entering it from above, plus one. */
function enteringWidth(row: Row): number {
  let w = row.lane;
  for (const e of row.incoming) w = Math.max(w, e.lane);
  return w + 1;
}
