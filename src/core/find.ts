import type { Commit } from './commit.ts';
import type { PathFilter } from './path-filter.ts';
import type { Ref, RefSnapshot } from './refs.ts';
import type { WorktreeInfo } from './worktrees.ts';

/** A parsed find query; `text` and `author` are fixed strings, compared case-insensitively. */
export interface FindQuery {
  /** '' when only `author:` is given. */
  text: string;
  author: string | undefined;
  /** `text` read as an abbreviated or full object name (4-40 hex digits), lowercase. */
  hashPrefix: string | undefined;
}

/** A commit the search found: what its row and the match list show. */
export type FindHit = Pick<Commit, 'hash' | 'subject' | 'author' | 'authorTime'> & {
  /** More than one parent, first-parent history or not. */
  merge: boolean;
};

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

/** The other worktrees with a commit whose folder name contains `text`. */
export function matchWorktrees(refs: RefSnapshot, text: string): WorktreeInfo[] {
  if (text === '') return [];
  const needle = text.toLowerCase();
  return refs.worktrees.filter((w) => w.head !== undefined && w.name.toLowerCase().includes(needle));
}

/** Where `needle` occurs in `text`, ignoring case, as [start, end) offsets that do not overlap. */
export function matchRanges(text: string, needle: string): [number, number][] {
  if (needle === '') return [];
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  return Array.from(text.matchAll(re), (m) => [m.index, m.index + m[0].length]);
}

/**
 * The match ↓ (or ↑ with `back`) goes to. `matches` in the order the widget counts them; `pos` is a
 * match's index in the loaded history, undefined when not loaded yet (it is then further down than
 * everything loaded). From `current`, a match, it steps through `matches`; from elsewhere, from
 * index `from` (a fraction between rows), to the nearest match below or above. Past the last match
 * it wraps around once the search is `done`; undefined when there is nowhere to go yet.
 */
export function nextMatch(
  matches: readonly string[],
  pos: (hash: string) => number | undefined,
  at: { current: string | undefined; from: number },
  back: boolean,
  done: boolean,
): string | undefined {
  if (matches.length === 0) return undefined;
  const i = at.current === undefined ? -1 : matches.indexOf(at.current);
  if (i >= 0) {
    const j = i + (back ? -1 : 1);
    if (j >= 0 && j < matches.length) return matches[j];
    return back ? matches.at(-1) : done ? matches[0] : undefined;
  }
  const key = (h: string) => pos(h) ?? Infinity;
  // Ties (matches not loaded yet) keep the order of `matches`.
  let best: string | undefined;
  for (const m of matches) {
    const k = key(m);
    if (
      back ? k < at.from && (best === undefined || k > key(best)) : k > at.from && (best === undefined || k < key(best))
    )
      best = m;
  }
  if (best !== undefined) return best;
  if (back) return matches.at(-1);
  return done ? matches[0] : undefined;
}

/** The widget's count: "3 of 21", "? of 21+" (more may come), "No results", "Searching…". */
export function matchCount(total: number, ordinal: number | undefined, more: boolean): string {
  if (total === 0) return more ? 'Searching…' : 'No results';
  return `${ordinal === undefined ? '?' : ordinal.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}${more ? '+' : ''}`;
}

/** Why the view leaves a commit out, and the change of view that would show it, if one is offered. */
export interface OutOfView {
  /** Completes "… is not in the graph: ", e.g. "the branch filter leaves it out." */
  text: string;
  action?: { label: string; refs?: string[]; firstParent?: false; path?: null };
}

/**
 * Explains why a view leaves out a commit that the refs `reachedBy` (full names) reach. A view of
 * every branch is never narrowed to a selection: it only says why.
 */
export function outOfView(
  reachedBy: readonly string[],
  view: { refs: string[] | null; firstParent: boolean; path?: PathFilter | null },
): OutOfView {
  const short = (name: string) => name.replace(/^refs\/(heads|remotes|tags)\//, '');
  const shown = (name: string) =>
    view.refs === null ? /^refs\/(heads|remotes)\//.test(name) : view.refs.includes(name);
  // A path history leaves out what does not change its paths, whatever else would show it.
  if (view.path && reachedBy.some(shown))
    return {
      text: `it does not change ${view.path.paths[0]}.`,
      action: { label: 'Show All Files', path: null },
    };
  if (view.firstParent && reachedBy.some(shown))
    return {
      text: 'it is not on the first-parent line.',
      action: { label: 'Show All Parents', firstParent: false },
    };
  if (reachedBy.length === 0) return { text: 'no branch or tag reaches it.' };
  if (view.refs === null) {
    const tags = reachedBy.map(short);
    const named = tags.length > 3 ? `${tags.slice(0, 3).join(', ')} and ${tags.length - 3} more` : tags.join(', ');
    return {
      text: `only ${tags.length === 1 ? 'tag' : 'tags'} ${named} ${tags.length === 1 ? 'reaches' : 'reach'} it, and the graph starts from branches, not tags.`,
    };
  }
  const prefix = ['refs/heads/', 'refs/remotes/', 'refs/tags/'];
  const ref = prefix.map((p) => reachedBy.find((r) => r.startsWith(p))).find((r) => r !== undefined)!;
  return {
    text: 'the branch filter leaves it out.',
    action: { label: `Show ${short(ref)} Too`, refs: [...view.refs, ref] },
  };
}
