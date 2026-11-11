/** A stretch of a segment's text; `marked` when it is part of a find match. */
export interface MessagePiece {
  text: string;
  marked: boolean;
}

/** Consecutive message text that is one link (`url`) or no link at all (undefined). */
export interface MessageSegment {
  url: string | undefined;
  pieces: MessagePiece[];
}

const SCHEME = /^https?:\/\//i;
const URLS = /\bhttps?:\/\/[^\s<>"`]+/giu;
/** Punctuation that ends the sentence or clause around a URL more often than the URL. */
const AFTER = '.,;:!?\'"';

/** Whether `url` is one the host may hand to the system: http or https, nothing else. */
export function isWebUrl(url: string): boolean {
  return SCHEME.test(url);
}

/** http and https URLs in `text` as [start, end) offsets, without the punctuation that follows them. */
function urlRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const m of text.matchAll(URLS)) {
    let url = m[0];
    for (;;) {
      const last = url.at(-1)!;
      // A closing parenthesis belongs to the URL only when the URL opened it.
      const outside = last === ')' && url.split('(').length < url.split(')').length;
      if (!AFTER.includes(last) && !outside) break;
      url = url.slice(0, -1);
    }
    if (url.replace(SCHEME, '') !== '') ranges.push([m.index, m.index + url.length]);
  }
  return ranges;
}

/**
 * `text` cut into links and the text between them, each cut again where a find match (`marks`:
 * [start, end) offsets in `text`, in order, not overlapping) starts or ends. The pieces, joined,
 * are `text`.
 */
export function messageSegments(text: string, marks: readonly (readonly [number, number])[]): MessageSegment[] {
  const segments: MessageSegment[] = [];
  const add = (start: number, end: number, link: boolean) => {
    if (start === end) return;
    const pieces: MessagePiece[] = [];
    let at = start;
    for (const [from, to] of marks) {
      const a = Math.max(from, at);
      const b = Math.min(to, end);
      if (a >= b) continue;
      if (a > at) pieces.push({ text: text.slice(at, a), marked: false });
      pieces.push({ text: text.slice(a, b), marked: true });
      at = b;
    }
    if (at < end) pieces.push({ text: text.slice(at, end), marked: false });
    segments.push({ url: link ? text.slice(start, end) : undefined, pieces });
  };
  let at = 0;
  for (const [start, end] of urlRanges(text)) {
    add(at, start, false);
    add(start, end, true);
    at = end;
  }
  add(at, text.length, false);
  return segments;
}
