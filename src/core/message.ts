/** Lines shorter than this were broken on purpose, not wrapped at a fill column. */
const WRAPPED_MIN = 50;
const TRAILER = /^[A-Za-z][A-Za-z0-9-]*: /;
const LIST_ITEM = /^([-*+]|\d+[.)])\s/;
const FENCE = /^(```|~~~)/;

/** A line whose break is part of its layout. */
const isLaidOut = (line: string) =>
  line.trim() === '' || /^\s/.test(line) || line.startsWith('>') || TRAILER.test(line) || LIST_ITEM.test(line);

/**
 * Joins the hard line breaks of wrapped prose in a commit body so the text can
 * wrap to the width it is shown at. Lines that are laid out on purpose stay as
 * they are: indented or fenced code, list items, quotes, trailers, short lines,
 * and a line break after a finished sentence before a new one.
 */
export function reflowBody(body: string): string {
  const out: string[] = [];
  let fenced = false;
  let joinable = false;
  for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
    if (FENCE.test(line)) fenced = !fenced;
    const prev = out[out.length - 1];
    const sentenceBreak = prev !== undefined && /[.!?:]$/.test(prev) && /^[A-Z0-9]/.test(line);
    if (!fenced && !FENCE.test(line) && !isLaidOut(line) && joinable && !sentenceBreak) {
      out[out.length - 1] = `${prev} ${line}`;
    } else {
      out.push(line);
    }
    // Only a long prose line can have been wrapped onto the next one.
    joinable = !fenced && !isLaidOut(line) && !FENCE.test(line) && line.length >= WRAPPED_MIN;
  }
  return out.join('\n');
}
