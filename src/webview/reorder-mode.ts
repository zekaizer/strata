import { clashes, moveBlock, moved, rewrittenCount } from '../core/reorder.ts';
import type { ReorderFacts } from '../shared/protocol.ts';

/**
 * The reorder mode: a draft that puts the commits of HEAD's first-parent line in another order.
 * The list shows `order` in the rows of `line`; nothing is rewritten until the draft is applied.
 */
export interface ReorderMode {
  /** HEAD when the mode was entered: the draft is of that line only. */
  head: string;
  /** The line as it is, newest first, as far as it is loaded. */
  line: readonly string[];
  /** The same commits as drafted. */
  order: readonly string[];
  /** The commits the user moved; the others only made room. Empty when the draft changes nothing. */
  touched: ReadonlySet<string>;
  /** Undefined until the host answers. */
  facts: ReorderFacts | undefined;
  /** Apply was sent and has not ended. */
  applying: boolean;
}

/** What the rows and the banner say about a draft. */
export interface DraftView {
  /** How many commits from the top applying rewrites; 0 when the draft changes nothing. */
  rewritten: number;
  /** How far each commit the user moved is from its place, in rows: negative is up. */
  moved: ReadonlyMap<string, number>;
  /** The commits that may conflict with another the draft puts the other way round. */
  clashing: ReadonlySet<string>;
  /** A path two such commits both change, and how many paths in all. */
  clashFile: string | undefined;
  clashFiles: number;
  /** How many of the rewritten commits a remote-tracking branch has. */
  pushed: number;
}

export function startReorder(head: string, line: readonly string[], facts?: ReorderFacts): ReorderMode {
  return { head, line, order: line, touched: new Set(), facts, applying: false };
}

/**
 * The mode once `line` is what is loaded of HEAD's line: a longer line extends the draft, a
 * shorter one (a reload under way) leaves it as it is.
 */
export function withLine(mode: ReorderMode, line: readonly string[]): ReorderMode {
  const known = mode.line.length;
  if (line.length <= known || mode.line.some((h, i) => line[i] !== h)) return mode;
  return { ...mode, line, order: [...mode.order, ...line.slice(known)] };
}

/** Moves order[from..to] to gap `gap` (see moveBlock); undefined when nothing would move. */
export function moveInDraft(mode: ReorderMode, from: number, to: number, gap: number): ReorderMode | undefined {
  const order = moveBlock(mode.order, from, to, gap);
  if (!order) return undefined;
  const same = rewrittenCount(mode.line, order) === 0;
  return { ...mode, order, touched: same ? new Set() : new Set([...mode.touched, ...mode.order.slice(from, to + 1)]) };
}

/** Moves order[from..to] one row up (-1) or down (1); undefined at the end of the line. */
export function stepInDraft(mode: ReorderMode, from: number, to: number, by: -1 | 1): ReorderMode | undefined {
  return moveInDraft(mode, from, to, by < 0 ? from - 1 : to + 2);
}

export function draftView(mode: ReorderMode): DraftView {
  const { line, order, facts } = mode;
  const rewritten = rewrittenCount(line, order);
  const files = new Map(Object.entries(facts?.files ?? {}));
  const clashing = new Set<string>();
  const shared = new Set<string>();
  let clashFile: string | undefined;
  for (const clash of clashes(line, order, files)) {
    clashing.add(clash.newer).add(clash.older);
    clashFile ??= clash.file;
    const theirs = new Set(files.get(clash.older));
    for (const f of files.get(clash.newer) ?? []) if (theirs.has(f)) shared.add(f);
  }
  return {
    rewritten,
    moved: new Map([...moved(line, order)].filter(([h]) => mode.touched.has(h))),
    clashing,
    clashFile,
    clashFiles: shared.size,
    pushed: facts ? Math.max(0, rewritten - facts.unpushed) : 0,
  };
}

/** The order to send: the commits applying rewrites, newest first. */
export function applyOrder(mode: ReorderMode): string[] {
  return mode.order.slice(0, rewrittenCount(mode.line, mode.order));
}

/** The gap a pointer at `y` drops into: `mids` are the vertical middles of the rows, top to bottom. */
export function gapAt(mids: readonly number[], y: number): number {
  let gap = 0;
  while (gap < mids.length && mids[gap]! < y) gap++;
  return gap;
}
