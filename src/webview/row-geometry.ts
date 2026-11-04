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
