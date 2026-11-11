/**
 * Vertical layout of the commit rows, before the inline details are inserted.
 * Rows that carry ref badges are taller by a band above the commit line.
 * Rows are only appended (pages arrive in order), so tops are kept as prefix sums.
 */
export class RowGeometry {
  readonly rowHeight: number;
  readonly bandHeight: number;
  /** tops[i] is the top of row i; tops[count] is the total height. */
  private tops: number[] = [0];
  private bands: boolean[] = [];

  constructor(rowHeight: number, bandHeight: number) {
    this.rowHeight = rowHeight;
    this.bandHeight = bandHeight;
  }

  get count(): number {
    return this.bands.length;
  }

  push(banded: boolean): void {
    this.bands.push(banded);
    this.tops.push(this.total() + this.rowHeight + (banded ? this.bandHeight : 0));
  }

  clear(): void {
    this.tops = [0];
    this.bands = [];
  }

  /** Top of row `index`; `index === count` gives the total height. */
  top(index: number): number {
    return this.tops[index] ?? this.total();
  }

  height(index: number): number {
    return this.rowHeight + (this.bands[index] ? this.bandHeight : 0);
  }

  banded(index: number): boolean {
    return this.bands[index] ?? false;
  }

  total(): number {
    return this.tops[this.tops.length - 1]!;
  }

  /** Row containing offset `y`, clamped to [0, count]. */
  indexAt(y: number): number {
    if (y < 0) return 0;
    if (y >= this.total()) return this.count;
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.tops[mid]! <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}

/**
 * Row a page away from `index` (PageDown: dir 1, PageUp: -1) in a view `view` px tall: the
 * farthest row that still fits on one screen together with row `index`. Moves at least one row.
 */
export function pageFrom(g: RowGeometry, index: number, view: number, dir: 1 | -1): number {
  if (dir > 0) {
    // The row containing the offset one view below this row's top does not fit; the one before does.
    const fits = g.indexAt(g.top(index) + view) - 1;
    return Math.min(g.count - 1, Math.max(index + 1, fits));
  }
  const y = g.top(index) + g.height(index) - view;
  if (y <= 0) return 0;
  const at = g.indexAt(y);
  const fits = g.top(at) < y ? at + 1 : at;
  return Math.max(0, Math.min(index - 1, fits));
}

/**
 * Row that Home (the first) or End (the last of the `count` rows in the list) selects; undefined
 * for any other key and in an empty list.
 */
export function edgeRow(key: string, count: number): number | undefined {
  if (count === 0) return undefined;
  return key === 'Home' ? 0 : key === 'End' ? count - 1 : undefined;
}

/**
 * Most height the details under row `selected` may take in a view `view` px tall: `share` of the
 * view, or more when the history ends before the view does, but never so much that the selected
 * row and the row after it cannot both be seen.
 */
export function expansionCap(g: RowGeometry, selected: number, view: number, share: number): number {
  const unused = view - (g.total() - g.top(selected));
  const next = selected + 1 < g.count ? g.height(selected + 1) : 0;
  return Math.floor(Math.min(view - g.height(selected) - next, Math.max(view * share, unused)));
}
