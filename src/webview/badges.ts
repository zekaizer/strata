import { headUpstream, pairRefs, type Ref, type RefSnapshot } from '../core/refs.ts';
import { holders, type WorktreeInfo, type WorktreeState } from '../core/worktrees.ts';
import type { BadgeContext, WorktreeContext } from '../shared/menu-context.ts';

/** Remote names shown inside a branch's badge; the rest collapse into "+k". */
const REMOTES_SHOWN = 2;

/** Something in a ref band a context menu can be opened on. */
export interface Target {
  text: string;
  context: BadgeContext;
}

/** Another worktree as a badge names it. */
export interface WorktreeMark {
  text: string;
  title: string;
  context: WorktreeContext;
  state: WorktreeState['kind'];
}

export interface Badge extends Target {
  /** The current branch and a detached HEAD share the head look; a detached worktree has its own. */
  look: 'head' | 'branch' | 'remote' | 'tag' | 'worktree' | 'more';
  /** A remote-tracking branch badge standing for the current branch's upstream. */
  tracked: boolean;
  title: string;
  /** Full names of the refs it stands for, merged remote names and "+N" contents included. */
  refs: string[];
  /** A branch's same-named remote-tracking branches: a target per name shown, then "+k" for the rest. */
  remotes: Target[];
  /** Short names of those remote-tracking branches, for screen readers. */
  also: string[];
  /** The other worktree a branch is checked out in; for a worktree badge, the one it is. */
  worktree: WorktreeMark | undefined;
}

/** What badges show of the other worktrees: who holds each branch, the detached ones by commit. */
export interface Worktrees {
  byBranch: ReadonlyMap<string, WorktreeInfo>;
  detachedAt: ReadonlyMap<string, readonly WorktreeInfo[]>;
  /** Whether the worktree at this path is open in this window. */
  shown: (path: string) => boolean;
}

export function worktreesOf(snapshot: RefSnapshot, shown: (path: string) => boolean = () => false): Worktrees {
  const detachedAt = new Map<string, WorktreeInfo[]>();
  for (const w of snapshot.worktrees)
    if (w.branch === undefined && w.head !== undefined) detachedAt.set(w.head, [...(detachedAt.get(w.head) ?? []), w]);
  return { byBranch: holders(snapshot.worktrees), detachedAt, shown };
}

/** The tooltip lines of a worktree: where it is, and why git keeps or would drop it. */
export function worktreeLines(w: WorktreeInfo): string[] {
  const state =
    w.state.kind === 'locked'
      ? [`Locked${w.state.reason === undefined ? '' : `: ${w.state.reason}`}`]
      : w.state.kind === 'prunable'
        ? [`Prunable: ${w.state.reason}`]
        : [];
  return [`Worktree ${w.name}${w.main ? ' (main)' : ''}: ${w.path}`, ...state];
}

function worktreeMark(hash: string, w: WorktreeInfo, shown: boolean): WorktreeMark {
  return {
    text: w.name,
    title: worktreeLines(w).join('\n'),
    state: w.state.kind,
    context: {
      webviewSection: 'worktree',
      strataHash: hash,
      strataWorktree: w.path,
      strataLocked: w.state.kind === 'locked',
      strataPrunable: w.state.kind === 'prunable',
      strataMain: w.main,
      strataShown: shown,
    },
  };
}

/** A row's badges in order and how much room its ref band has, in px. */
export interface BandFit {
  /** Natural width of each badge. */
  widths: readonly number[];
  /** Width of the "+N" badge standing for `hidden` badges. */
  more: (hidden: number) => number;
  /** Narrowest the last kept badge may ellipsize to. */
  minWidth: number;
  gap: number;
  available: number;
}

/**
 * How many badges from the front a band shows: all at natural width but the last, which may
 * ellipsize down to `minWidth`, followed by a "+N" for the rest that fits too. At least one.
 */
export function fitBadges({ widths, more, minWidth, gap, available }: BandFit): number {
  const n = widths.length;
  let kept = 1;
  let used = 0;
  for (let k = 1; k <= n; k++) {
    const tail = k < n ? gap + more(n - k) : 0;
    if (used + Math.min(widths[k - 1]!, minWidth) + tail <= available) kept = k;
    used += widths[k - 1]! + gap;
  }
  return Math.min(kept, n);
}

/** `refsByHash` without the refs named in `hidden`; commits left with none are dropped. */
export function shownRefs(
  refsByHash: ReadonlyMap<string, readonly Ref[]>,
  hidden: { has(name: string): boolean },
): Map<string, Ref[]> {
  const shown = new Map<string, Ref[]>();
  for (const [hash, refs] of refsByHash) {
    const kept = refs.filter((r) => !hidden.has(r.name));
    if (kept.length > 0) shown.set(hash, kept);
  }
  return shown;
}

/**
 * The badges of one commit: a detached HEAD, other worktrees detached here, then `refs` (in
 * badgeOrder) with each local branch merged with its same-named remote-tracking branches and
 * naming the worktree it is checked out in; past the first `keep(all)` the rest collapse into "+N".
 */
export function rowBadges(
  hash: string,
  refs: readonly Ref[],
  snapshot: RefSnapshot,
  keep: (all: readonly Badge[]) => number,
  worktrees: Worktrees = worktreesOf(snapshot),
): Badge[] {
  const all: Badge[] = [];
  if (hash === snapshot.head && snapshot.headBranch === undefined)
    all.push({
      look: 'head',
      text: 'HEAD',
      title: 'Detached HEAD',
      context: { webviewSection: 'head', strataHash: hash },
      tracked: false,
      refs: [],
      remotes: [],
      also: [],
      worktree: undefined,
    });
  for (const w of worktrees.detachedAt.get(hash) ?? []) {
    const mark = worktreeMark(hash, w, worktrees.shown(w.path));
    all.push({
      look: 'worktree',
      text: w.name,
      title: `${mark.title}\nDetached HEAD`,
      context: mark.context,
      tracked: false,
      refs: [],
      remotes: [],
      also: [],
      worktree: mark,
    });
  }
  const upstream = headUpstream(snapshot);
  for (const { ref, remotes } of pairRefs(refs, snapshot.remotes))
    all.push(refBadge(hash, ref, remotes, snapshot.headBranch, upstream, worktrees));
  const kept = keep(all);
  if (kept >= all.length) return all;
  const rest = all.slice(kept);
  const names = rest.flatMap((b) => b.refs);
  const more: Badge = {
    look: 'more',
    text: `+${rest.length}`,
    title: rest.map((b) => (b.also.length > 0 ? `${b.text} (also ${b.also.join(', ')})` : b.title)).join('\n'),
    context: { webviewSection: 'refs', strataHash: hash, strataRefs: names.join(' ') },
    tracked: false,
    refs: names,
    remotes: [],
    also: [],
    worktree: undefined,
  };
  return [...all.slice(0, kept), more];
}

function refBadge(
  hash: string,
  r: Ref,
  remotes: Ref[],
  headBranch: string | undefined,
  upstream: string | undefined,
  worktrees: Worktrees,
): Badge {
  const current = r.kind === 'branch' && r.short === headBranch;
  const holder = r.kind === 'branch' ? worktrees.byBranch.get(r.name) : undefined;
  const context: BadgeContext =
    r.kind === 'branch'
      ? {
          webviewSection: 'branch',
          strataHash: hash,
          strataRef: r.name,
          strataIsCurrent: current,
          strataUpstream: r.tracks === true,
          strataInWorktree: holder !== undefined,
        }
      : { webviewSection: r.kind === 'remote' ? 'remoteBranch' : 'tag', strataHash: hash, strataRef: r.name };
  const shown = remotes.length > REMOTES_SHOWN ? remotes.slice(0, REMOTES_SHOWN) : remotes;
  const hidden = remotes.slice(shown.length);
  const names = [r.name, ...remotes.map((x) => x.name)];
  const worktree = holder && worktreeMark(hash, holder, worktrees.shown(holder.path));
  return {
    look: current ? 'head' : r.kind,
    tracked: r.kind === 'remote' && r.name === upstream,
    text: r.short,
    title: [...names, ...(holder ? [`Checked out in another worktree`, ...worktreeLines(holder)] : [])].join('\n'),
    context,
    refs: names,
    remotes: [
      // origin/main -> origin (remote names may contain slashes, branch names too).
      ...shown.map((x): Target => ({
        text: x.short.slice(0, x.short.length - r.short.length - 1),
        context: { webviewSection: 'remoteBranch', strataHash: hash, strataRef: x.name },
      })),
      ...(hidden.length > 0
        ? [
            {
              text: `+${hidden.length}`,
              context: { webviewSection: 'refs', strataHash: hash, strataRefs: hidden.map((x) => x.name).join(' ') },
            } satisfies Target,
          ]
        : []),
    ],
    also: remotes.map((x) => x.short),
    worktree,
  };
}

/** The refs of `badges` (not collapsed into "+N") as read: each by its kind, in order. */
export function refsLabel(badges: readonly Badge[]): string {
  return badges
    .map((b) => {
      if (b.context.webviewSection === 'head') return 'detached HEAD';
      if (b.look === 'worktree') return `worktree ${b.text}, detached${stateSaid(b.worktree)}`;
      const kind =
        b.look === 'head'
          ? 'current branch'
          : b.look === 'remote'
            ? b.tracked
              ? 'upstream'
              : 'remote branch'
            : b.look;
      const also = b.also.length > 0 ? `, also ${b.also.join(', ')}` : '';
      const worktree = b.worktree ? `, in worktree ${b.worktree.text}${stateSaid(b.worktree)}` : '';
      return `${kind} ${b.text}${also}${worktree}`;
    })
    .join('; ');
}

const stateSaid = (w: WorktreeMark | undefined) =>
  w?.state === 'locked' ? ', locked' : w?.state === 'prunable' ? ', prunable' : '';

/**
 * Refs an operation moved, by full name: moved or new refs, the branch HEAD switched to, and
 * "HEAD" when a detached HEAD moved.
 */
export function landedRefs(before: RefSnapshot, after: RefSnapshot): string[] {
  const was = new Map(before.refs.map((r) => [r.name, r.hash]));
  const moved = after.refs.filter((r) => was.get(r.name) !== r.hash).map((r) => r.name);
  const switched =
    after.headBranch !== undefined && after.headBranch !== before.headBranch ? [`refs/heads/${after.headBranch}`] : [];
  const detached = after.headBranch === undefined && after.head !== before.head ? ['HEAD'] : [];
  return [...new Set([...moved, ...switched, ...detached])];
}

/** One line of a commit's ref card. */
export interface CardRef {
  look: Exclude<Badge['look'], 'more'>;
  text: string;
  /** "detached", "current branch" or "upstream". */
  note: string | undefined;
  /** The other worktree a branch is checked out in. */
  worktree: string | undefined;
  /** A worktree's (the line's, or its branch's) that git keeps or would drop. */
  state: 'locked' | 'prunable' | undefined;
  /** Pattern of the rule hiding its badge. */
  hiddenBy: string | undefined;
}

const cardState = (w: WorktreeInfo | undefined) =>
  w?.state.kind === 'locked' || w?.state.kind === 'prunable' ? w.state.kind : undefined;

/**
 * Every ref of one commit for its ref card: a detached HEAD, other worktrees detached here, then
 * `refs` (in badgeOrder) one by one, those whose badges are collapsed into "+N" or hidden by a
 * rule included.
 */
export function cardRefs(
  hash: string,
  refs: readonly Ref[],
  snapshot: RefSnapshot,
  hidden: { get(name: string): { pattern: string } | undefined },
  worktrees: Worktrees = worktreesOf(snapshot),
): CardRef[] {
  const upstream = headUpstream(snapshot);
  const none = { worktree: undefined, state: undefined, hiddenBy: undefined };
  const head: CardRef[] =
    hash === snapshot.head && snapshot.headBranch === undefined
      ? [{ look: 'head', text: 'HEAD', note: 'detached', ...none }]
      : [];
  const detached = (worktrees.detachedAt.get(hash) ?? []).map((w): CardRef => ({
    look: 'worktree',
    text: w.name,
    note: 'detached',
    ...none,
    state: cardState(w),
  }));
  return [
    ...head,
    ...detached,
    ...refs.map((r): CardRef => {
      const current = r.kind === 'branch' && r.short === snapshot.headBranch;
      const holder = r.kind === 'branch' ? worktrees.byBranch.get(r.name) : undefined;
      return {
        look: current ? 'head' : r.kind,
        text: r.short,
        note: current ? 'current branch' : r.name === upstream ? 'upstream' : undefined,
        worktree: holder?.name,
        state: cardState(holder),
        hiddenBy: hidden.get(r.name)?.pattern,
      };
    }),
  ];
}
