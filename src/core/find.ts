import type { Commit } from './commit.ts';
import type { Ref, RefSnapshot } from './refs.ts';

/** A parsed find query; `text` and `author` are fixed strings, compared case-insensitively. */
export interface FindQuery {
  /** '' when only `author:` is given. */
  text: string;
  author: string | undefined;
  /** `text` read as an abbreviated or full object name (4-40 hex digits), lowercase. */
  hashPrefix: string | undefined;
}

/** A commit the search found: what its row and the match list show. */
export type FindHit = Pick<Commit, 'hash' | 'subject' | 'author' | 'authorTime'>;

const HASH_PREFIX = /^[0-9a-f]{4,40}$/i;
/** `author:` at the start of a word, then a quoted value (closing quote optional) or a word. */
const AUTHOR = /(^|\s)author:(?:"([^"]*)"?|(\S*))/i;

/** The query typed in the find widget; undefined when there is nothing to search for. */
export function parseFindQuery(input: string): FindQuery | undefined {
  const m = AUTHOR.exec(input);
  const author = (m?.[2] ?? m?.[3])?.trim() || undefined;
  const rest = m ? `${input.slice(0, m.index)}${m[1]}${input.slice(m.index + m[0].length)}` : input;
  const text = rest.trim().replace(/\s+/g, ' ');
  if (text === '' && author === undefined) return undefined;
  const hashPrefix = author === undefined && HASH_PREFIX.test(text) ? text.toLowerCase() : undefined;
  return { text, author, hashPrefix };
}

const KIND_ORDER: Record<Ref['kind'], number> = { branch: 0, remote: 1, tag: 2 };

/** Refs whose short name contains `text`: the current branch first, then branches, remote branches, tags. */
export function matchRefs(refs: RefSnapshot, text: string): Ref[] {
  if (text === '') return [];
  const needle = text.toLowerCase();
  const rank = (r: Ref) => (r.kind === 'branch' && r.short === refs.headBranch ? -1 : KIND_ORDER[r.kind]);
  return refs.refs.filter((r) => r.short.toLowerCase().includes(needle)).sort((a, b) => rank(a) - rank(b));
}

/** Where `needle` occurs in `text`, ignoring case, as [start, end) offsets that do not overlap. */
export function matchRanges(text: string, needle: string): [number, number][] {
  if (needle === '') return [];
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  return Array.from(text.matchAll(re), (m) => [m.index, m.index + m[0].length]);
}
