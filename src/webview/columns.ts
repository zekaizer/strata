/** Natural widths in px of the optional row columns and the fixed parts around the subject. */
export interface ColumnWidths {
  /** Width of the list. */
  list: number;
  /** Graph column. */
  graph: number;
  /** Widest author name (capped), widest date, the short hash. */
  author: number;
  date: number;
  hash: number;
  /** Gap between columns, and the row's right padding. */
  gap: number;
  padding: number;
}

/** Which optional columns a row shows (or, from the `strata.columns` setting, may show at all). */
export interface ColumnChoice {
  author: boolean;
  date: boolean;
  hash: boolean;
}

/** The order the columns give way in while the subject is narrower than it wants; the hash stays. */
const GIVE_WAY = ['date', 'author'] as const;

/**
 * The columns of `allowed` that leave the subject `wanted` px, or all of the row's text area (the
 * row past the graph) when that is narrower: the date goes first (graph order and the tooltip still
 * tell it), then the author. The hash stays until even without them the subject would be narrower
 * than `hashFloor` px.
 */
export function chooseColumns(w: ColumnWidths, allowed: ColumnChoice, wanted: number, hashFloor: number): ColumnChoice {
  const area = w.list - w.graph - w.gap - w.padding;
  const taken = (c: ColumnChoice) =>
    (c.author ? w.gap + w.author : 0) + (c.date ? w.gap + w.date : 0) + (c.hash ? w.gap + w.hash : 0);
  let shown = { ...allowed };
  for (const column of GIVE_WAY) {
    if (area - taken(shown) >= Math.min(wanted, area)) return shown;
    shown = { ...shown, [column]: false };
  }
  if (area - taken(shown) >= Math.min(hashFloor, area)) return shown;
  return { ...shown, hash: false };
}
