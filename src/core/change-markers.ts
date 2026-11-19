/** How a line differs from the other side of a commit's change. */
export type LineChange = 'added' | 'modified' | 'removed';

/** Lines `start` to `end` (1-based, inclusive) changed. */
export interface LineMarker {
  kind: LineChange;
  start: number;
  end: number;
}

/** Lines were added or removed on the other side between line `after` and the next; 0 is above line 1. */
export interface GapMarker {
  kind: 'added' | 'removed';
  after: number;
}

export interface SideMarkers {
  lines: LineMarker[];
  gaps: GapMarker[];
}

/** The markers of a file's two versions: `before` the change and `after` it. */
export interface ChangeMarkers {
  before: SideMarkers;
  after: SideMarkers;
}

/** Reads the hunks of `git diff -U0` for one file into the markers of both of its versions. */
export function changeMarkers(diff: string): ChangeMarkers {
  const before: SideMarkers = { lines: [], gaps: [] };
  const after: SideMarkers = { lines: [], gaps: [] };
  // Hunk bodies start with '+', '-', ' ' or '\\', so only a header starts with '@@'. Without a
  // count, a side has one line; with 0 lines, its start is the line above the change.
  for (const match of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const from = Number(match[1]);
    const fromCount = Number(match[2] ?? 1);
    const to = Number(match[3]);
    const toCount = Number(match[4] ?? 1);
    if (fromCount === 0) {
      after.lines.push({ kind: 'added', start: to, end: to + toCount - 1 });
      before.gaps.push({ kind: 'added', after: from });
    } else if (toCount === 0) {
      before.lines.push({ kind: 'removed', start: from, end: from + fromCount - 1 });
      after.gaps.push({ kind: 'removed', after: to });
    } else {
      before.lines.push({ kind: 'modified', start: from, end: from + fromCount - 1 });
      after.lines.push({ kind: 'modified', start: to, end: to + toCount - 1 });
    }
  }
  return { before, after };
}

/** The line to show first: the top-most change of the side, or undefined when it has none. */
export function firstChange(side: SideMarkers): number | undefined {
  const lines = [...side.lines.map((l) => l.start), ...side.gaps.map((g) => Math.max(g.after, 1))];
  return lines.length > 0 ? Math.min(...lines) : undefined;
}

/** What a version's gutter shows beside one line: a bar, and halves of the triangles on its edges. */
export interface LineGlyph {
  bar?: LineChange;
  /** A gap above the line: the lower half of the triangle on its top edge. */
  top?: GapMarker['kind'];
  /** A gap below the line: the upper half of the triangle on its bottom edge. */
  bottom?: GapMarker['kind'];
}

/** The glyphs of a version's `lineCount` lines, by 0-based line; lines without one are absent. */
export function lineGlyphs(side: SideMarkers, lineCount: number): Map<number, LineGlyph> {
  const glyphs = new Map<number, LineGlyph>();
  const at = (line: number) => {
    const g = glyphs.get(line) ?? {};
    glyphs.set(line, g);
    return g;
  };
  for (const m of side.lines) for (let n = m.start; n <= Math.min(m.end, lineCount); n++) at(n - 1).bar = m.kind;
  for (const g of side.gaps) {
    if (g.after >= 1 && g.after <= lineCount) at(g.after - 1).bottom = g.kind;
    if (g.after < lineCount) at(g.after).top = g.kind;
  }
  return glyphs;
}
