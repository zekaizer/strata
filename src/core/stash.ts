import type { Commit } from './commit.ts';

/** Where a stash's row is drawn: above its base, or above its branch's tip once the base left that branch. */
export type StashAnchor = { kind: 'base' } | { kind: 'tip'; tip: string };

/** One entry of the stash list (refs/stash and its reflog). */
export interface StashEntry {
  /** The stash commit W; stable while stash@{n} numbers shift. */
  hash: string;
  /** n in stash@{n}. */
  index: number;
  /** The commit the stash was made on (W^1). */
  base: string;
  /** The commit holding untracked files (W^3), when the stash has them. */
  untracked: string | undefined;
  /** The reflog subject, e.g. "On main: message", "WIP on main: 1a2b3c4 subject" or "autostash". */
  message: string;
  /** The branch the stash was made on (named in W's subject); undefined on a detached HEAD. */
  branch: string | undefined;
  /** Seconds since the epoch. */
  time: number;
  /** Left behind by git's or Strata's autostash. */
  autostash: boolean;
  anchor: StashAnchor;
  /** Files changed against the base and untracked files; undefined when they were not counted in time. */
  files: { changed: number; untracked: number } | undefined;
}

/** Fields per entry of the `git log -g -z` format used to read the stash list. */
export const STASH_FIELDS = 6;

/** Parses records of `%H %P %gd %gs %s %ct`, each field NUL-terminated (`git log -g -z`). */
export function parseStashList(out: string): StashEntry[] {
  const f = out.split('\0');
  const list: StashEntry[] = [];
  for (let i = 0; i + STASH_FIELDS <= f.length; i += STASH_FIELDS) {
    const [hash, parents, selector, message, subject, time] = f.slice(i, i + STASH_FIELDS) as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const [base, , untracked] = parents.split(' ');
    // Branch names cannot contain ':'. git's autostash reflog says only "autostash"; W's subject names the branch.
    const branch = (BRANCH.exec(subject) ?? BRANCH.exec(message))?.[1];
    list.push({
      hash,
      index: Number(/\{(\d+)\}$/.exec(selector)?.[1] ?? list.length),
      base: base ?? '',
      untracked,
      message,
      branch: branch === '(no branch)' ? undefined : branch,
      time: Number(time),
      autostash: message === 'autostash' || message.replace(BRANCH, '').startsWith('Strata autostash:'),
      anchor: { kind: 'base' },
      files: undefined,
    });
  }
  return list;
}

const BRANCH = /^(?:WIP on|On) ([^:]+): /;

/** The commit a stash's row is drawn above. */
export const anchorOf = (s: StashEntry): string => (s.anchor.kind === 'tip' ? s.anchor.tip : s.base);

/** Stashes by the commit their rows are drawn above, stash@{0} first. */
export function anchoredAt(stashes: readonly StashEntry[]): Map<string, StashEntry[]> {
  const map = new Map<string, StashEntry[]>();
  for (const s of [...stashes].sort((a, b) => a.index - b.index)) {
    const list = map.get(anchorOf(s));
    if (list) list.push(s);
    else map.set(anchorOf(s), [s]);
  }
  return map;
}

/** A row of the commit list. `row` is the layout row of the commit, or of the commit a stash is drawn above. */
export type ListRow =
  { kind: 'commit'; commit: Commit; row: number } | { kind: 'stash'; stash: StashEntry; row: number };

/** What a row stands for: the commit, or the stash commit W. */
export const rowHash = (r: ListRow): string => (r.kind === 'commit' ? r.commit.hash : r.stash.hash);

/**
 * Rows of one page: each commit, preceded by the stashes drawn above it (stash@{0} first).
 * Looks at nothing but the page and the map, so pages can be interleaved one at a time.
 */
export function interleave(
  page: readonly Commit[],
  firstLayoutRow: number,
  anchors: ReadonlyMap<string, readonly StashEntry[]>,
): ListRow[] {
  const rows: ListRow[] = [];
  page.forEach((commit, i) => {
    const row = firstLayoutRow + i;
    for (const stash of anchors.get(commit.hash) ?? []) rows.push({ kind: 'stash', stash, row });
    rows.push({ kind: 'commit', commit, row });
  });
  return rows;
}

/** "On main:" and "half-done lexer" of "On main: half-done lexer"; git's autostash has no prefix. */
export function stashLabel(s: StashEntry): { prefix: string | undefined; text: string } {
  const m = /^((?:WIP on|On) [^:]+:) (.*)$/s.exec(s.message);
  return m ? { prefix: m[1], text: m[2]! } : { prefix: undefined, text: s.message };
}

/**
 * What a stash row says to a tooltip and a screen reader, kind first. `base` is its base's short
 * hash and, when known, subject; `stashed` is the formatted stash time.
 */
export function describeStash(
  s: StashEntry,
  base: { short: string; subject: string | undefined },
  stashed: string,
): string {
  const subject = base.subject === undefined ? '' : ` "${base.subject}"`;
  const moved = s.anchor.kind === 'tip' ? `, no longer on '${s.branch ?? ''}'` : '';
  const plural = (n: number) => (n === 1 ? '' : 's');
  const files =
    s.files === undefined
      ? ''
      : ` ${s.files.changed} file${plural(s.files.changed)} changed${s.files.untracked ? `, ${s.files.untracked} untracked` : ''}.`;
  return `Stash stash@{${s.index}}: ${s.message}. Based on ${base.short}${subject}${moved}.${files} Stashed ${stashed}.`;
}
