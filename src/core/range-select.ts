import { TIDY_WHOLE_HISTORY } from './wording.ts';

/** Said when Shift-click selects no run because one of its ends cannot be rewritten. */
export const RANGE_OFF_LINE =
  "Selecting commits to squash or drop works on the current branch's first-parent line, from HEAD down to the first merge.";

export interface ShiftClick {
  /** Where the run starts: the anchor of the run already selected, else the selected row. */
  anchor: string | undefined;
  /** The clicked commit; undefined for a row that is not a commit. */
  target: string | undefined;
  pathFiltered: boolean;
  rewritable: (hash: string) => boolean;
}

/** A run of commits to select, or a plain click with what to tell the user about it, if anything. */
export type ShiftClickResult =
  { kind: 'range'; anchor: string; end: string } | { kind: 'click'; why: string | undefined };

export function shiftClick(c: ShiftClick): ShiftClickResult {
  if (c.pathFiltered) return { kind: 'click', why: TIDY_WHOLE_HISTORY };
  if (c.anchor === undefined || c.anchor === c.target) return { kind: 'click', why: undefined };
  if (c.target === undefined || !c.rewritable(c.anchor) || !c.rewritable(c.target))
    return { kind: 'click', why: RANGE_OFF_LINE };
  return { kind: 'range', anchor: c.anchor, end: c.target };
}
