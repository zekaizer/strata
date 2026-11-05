import { isStrataAutostash } from './autostash.ts';
import type { Commit } from './commit.ts';
import type { ChangesSummary } from './repo-state.ts';

/** Where a stash's row is drawn: above its base, or above its branch's tip once the base left that branch. */
export type StashAnchor =
  | { kind: 'base' }
  | { kind: 'tip'; tip: string }
  /** No start point of the graph (branch, remote-tracking branch, HEAD) reaches its base: never drawn. */
  | { kind: 'unreachable' };

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
      autostash: message === 'autostash' || isStrataAutostash(message.replace(BRANCH, '')),
      anchor: { kind: 'base' },
      files: undefined,
    });
  }
  return list;
}

const BRANCH = /^(?:WIP on|On) ([^:]+): /;

/** The commit a stash's row is drawn above. */
export const anchorOf = (s: StashEntry): string => (s.anchor.kind === 'tip' ? s.anchor.tip : s.base);

/**
 * Stashes by the commit their rows are drawn above: those displaced there first, then those made
 * on it, which sit right above it so their spine runs unbroken into its node. Each group is
 * stash@{0} first.
 */
export function anchoredAt(stashes: readonly StashEntry[]): Map<string, StashEntry[]> {
  const displaced = (s: StashEntry) => (s.anchor.kind === 'tip' ? 0 : 1);
  const map = new Map<string, StashEntry[]>();
  for (const s of [...stashes].sort((a, b) => displaced(a) - displaced(b) || a.index - b.index)) {
    const list = map.get(anchorOf(s));
    if (list) list.push(s);
    else map.set(anchorOf(s), [s]);
  }
  return map;
}

/**
 * A row of the commit list. `row` is the layout row of the commit, of the commit a stash is drawn
 * above, or of HEAD for the uncommitted changes (-1 before the first commit: there is no HEAD).
 */
export type ListRow =
  | { kind: 'commit'; commit: Commit; row: number }
  | { kind: 'stash'; stash: StashEntry; row: number }
  | { kind: 'changes'; changes: ChangesSummary; row: number };

/** What the uncommitted changes row stands for in rowHash: no commit id, so no saved selection names it by mistake. */
export const CHANGES_ROW = 'changes';

/** What a row stands for: the commit, the stash commit W, or CHANGES_ROW. */
export const rowHash = (r: ListRow): string =>
  r.kind === 'commit' ? r.commit.hash : r.kind === 'stash' ? r.stash.hash : CHANGES_ROW;

/** The uncommitted changes and the commit they are on (undefined before the first commit). */
export interface ChangesAt {
  head: string | undefined;
  summary: ChangesSummary;
}

/**
 * Rows of one page: each commit, preceded by the stashes drawn above it, in anchoredAt's order.
 * The uncommitted changes go above HEAD and its stashes, or first in the list without a HEAD.
 * Looks at nothing but the page, the map and the changes, so pages can be interleaved one at a time.
 */
export function interleave(
  page: readonly Commit[],
  firstLayoutRow: number,
  anchors: ReadonlyMap<string, readonly StashEntry[]>,
  changes?: ChangesAt,
): ListRow[] {
  const rows: ListRow[] = [];
  if (changes && changes.head === undefined && firstLayoutRow === 0)
    rows.push({ kind: 'changes', changes: changes.summary, row: -1 });
  page.forEach((commit, i) => {
    const row = firstLayoutRow + i;
    if (changes && commit.hash === changes.head) rows.push({ kind: 'changes', changes: changes.summary, row });
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

/** Whether a stash's row is in the graph, as only the webview knows. */
export type StashShown = 'drawn' | 'notLoaded' | 'notInView' | 'hidden';

export type StashPickItem =
  | { kind: 'separator'; label: string }
  | { kind: 'stash'; hash: string; label: string; description: string; detail: string };

/**
 * Items of the Show Stashes quick pick: stashes made on the current branch first, then the rest,
 * each saying where its row is or why it is not in the graph. `now` is in seconds.
 */
export function stashPickItems(
  stashes: readonly StashEntry[],
  shown: Readonly<Record<string, StashShown>>,
  headBranch: string | undefined,
  now: number,
): StashPickItem[] {
  const item = (s: StashEntry): StashPickItem => ({
    kind: 'stash',
    hash: s.hash,
    label: `stash@{${s.index}}  ${s.message}`,
    description: timeAgo(s.time, now),
    detail: PICK_DETAIL[shown[s.hash] ?? 'notInView'](s),
  });
  const sorted = [...stashes].sort((a, b) => a.index - b.index);
  const current = sorted.filter((s) => headBranch !== undefined && s.branch === headBranch);
  const elsewhere = sorted.filter((s) => !current.includes(s));
  if (current.length === 0 || elsewhere.length === 0) return sorted.map(item);
  return [
    { kind: 'separator', label: `On ${headBranch} (current)` },
    ...current.map(item),
    { kind: 'separator', label: 'Elsewhere' },
    ...elsewhere.map(item),
  ];
}

const PICK_DETAIL: Record<StashShown, (s: StashEntry) => string> = {
  drawn: (s) => `In the graph above ${anchorOf(s).slice(0, 7)}`,
  notLoaded: () => 'Not loaded yet: Enter searches further down the history',
  notInView: (s) =>
    s.anchor.kind === 'unreachable'
      ? `Not in the graph: no branch or HEAD contains its base commit ${s.base.slice(0, 7)}`
      : 'Not in this view (filter, first parent, or its branch was deleted)',
  hidden: () => 'Stash rows are hidden: Enter shows them',
};

const AGO: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400],
  ['month', 30 * 86_400],
  ['week', 7 * 86_400],
  ['day', 86_400],
  ['hour', 3600],
  ['minute', 60],
];
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "3 weeks ago", "yesterday", "just now". Both times in seconds. */
export function timeAgo(time: number, now: number): string {
  const ago = now - time;
  for (const [unit, seconds] of AGO) if (ago >= seconds) return relative.format(-Math.floor(ago / seconds), unit);
  return 'just now';
}
