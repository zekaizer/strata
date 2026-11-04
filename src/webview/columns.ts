/** Natural widths in px of the optional row columns and the fixed parts around the subject. */
export interface ColumnWidths {
  /** Width of the list. */
  list: number;
  /** Graph column. */
  graph: number;
  /** Widest author name, widest full date, widest short date, the short hash. */
  author: number;
  dateFull: number;
  dateShort: number;
  hash: number;
  /** Gap between columns, and the row's right padding. */
  gap: number;
  padding: number;
}

/** Which optional columns a row shows. */
export interface ColumnChoice {
  author: boolean;
  date: 'full' | 'short' | 'none';
}

/**
 * The most detail that still leaves the subject `subjectMin` px: the full date gives way to the
 * short one, then the date goes, then the author. The SHA always stays.
 */
export function chooseColumns(w: ColumnWidths, subjectMin: number): ColumnChoice {
  const steps: ColumnChoice[] = [
    { author: true, date: 'full' },
    { author: true, date: 'short' },
    { author: true, date: 'none' },
    { author: false, date: 'none' },
  ];
  const subject = (c: ColumnChoice) =>
    w.list -
    (w.graph + w.gap) -
    w.padding -
    (w.gap + w.hash) -
    (c.author ? w.gap + w.author : 0) -
    (c.date === 'full' ? w.gap + w.dateFull : c.date === 'short' ? w.gap + w.dateShort : 0);
  return steps.find((c) => subject(c) >= subjectMin) ?? steps[steps.length - 1]!;
}
