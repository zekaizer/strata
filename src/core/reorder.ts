/**
 * A draft that reorders the top of HEAD's first-parent line. `line` is the line as it is, newest
 * first; `order` the drafted sequence of the same commits (a permutation of `line`, or of its top).
 */

/**
 * Moves order[from..to] (inclusive) so it starts at gap `gap`: 0 is above the first item,
 * order.length below the last, counted before the move. Undefined when nothing would move.
 */
export function moveBlock<T>(order: readonly T[], from: number, to: number, gap: number): T[] | undefined {
  const inList = (i: number, last: number) => Number.isInteger(i) && i >= 0 && i <= last;
  if (!inList(from, to) || !inList(to, order.length - 1) || !inList(gap, order.length)) return undefined;
  if (gap >= from && gap <= to + 1) return undefined;
  const block = order.slice(from, to + 1);
  const rest = [...order.slice(0, from), ...order.slice(to + 1)];
  const at = gap < from ? gap : gap - block.length;
  return [...rest.slice(0, at), ...block, ...rest.slice(at)];
}

/** How many commits from the top a draft rewrites: the deepest index whose commit differs, plus one; 0 when unchanged. */
export function rewrittenCount(line: readonly string[], order: readonly string[]): number {
  let deepest = order.length - 1;
  while (deepest >= 0 && order[deepest] === line[deepest]) deepest--;
  return deepest + 1;
}

/**
 * Two commits a draft puts the other way round that change a file in common: replaying them may
 * conflict. `newer` is the one `line` has on top; `file` is the first common path as `newer` lists
 * its files, `files` how many they share.
 */
export interface Clash {
  newer: string;
  older: string;
  file: string;
  files: number;
}

/** The clashes of a draft, in the sequence `order` has the `older` commits, then the `newer` ones; `files`: changed paths by commit. */
export function clashes(
  line: readonly string[],
  order: readonly string[],
  files: ReadonlyMap<string, readonly string[]>,
): Clash[] {
  const was = new Map(line.map((h, i) => [h, i]));
  const sets = new Map<string, Set<string>>();
  const setOf = (h: string) => {
    let s = sets.get(h);
    if (!s) sets.set(h, (s = new Set(files.get(h))));
    return s;
  };
  const found: Clash[] = [];
  const n = rewrittenCount(line, order);
  for (let i = 0; i < n; i++) {
    const older = order[i]!;
    for (let j = i + 1; j < n; j++) {
      const newer = order[j]!;
      if (was.get(older)! < was.get(newer)!) continue;
      const theirs = setOf(older);
      const common = theirs.size === 0 ? [] : (files.get(newer) ?? []).filter((f) => theirs.has(f));
      if (common.length > 0) found.push({ newer, older, file: common[0]!, files: common.length });
    }
  }
  return found;
}

/** How far each commit moved, in rows: negative is up (toward HEAD). Commits that keep their place are left out. */
export function moved(line: readonly string[], order: readonly string[]): Map<string, number> {
  const was = new Map(line.map((h, i) => [h, i]));
  const by = new Map<string, number>();
  order.forEach((h, i) => {
    const d = i - (was.get(h) ?? i);
    if (d !== 0) by.set(h, d);
  });
  return by;
}
