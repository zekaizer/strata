import { headUpstream, pairRefs, type Ref, type RefSnapshot } from '../core/refs.ts';
import type { BadgeContext } from '../shared/menu-context.ts';

/** Remote names shown inside a branch's badge; the rest collapse into "+k". */
const REMOTES_SHOWN = 2;

/** Something in a ref band a context menu can be opened on. */
export interface Target {
  text: string;
  context: BadgeContext;
}

export interface Badge extends Target {
  /** The current branch and a detached HEAD share the head look. */
  look: 'head' | 'branch' | 'remote' | 'tag' | 'more';
  /** A remote-tracking branch badge standing for the current branch's upstream. */
  tracked: boolean;
  title: string;
  /** Full names of the refs it stands for, merged remote names and "+N" contents included. */
  refs: string[];
  /** A branch's same-named remote-tracking branches: a target per name shown, then "+k" for the rest. */
  remotes: Target[];
  /** Short names of those remote-tracking branches, for screen readers. */
  also: string[];
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
 * The badges of one commit: a detached HEAD, then `refs` (in badgeOrder) with each local branch
 * merged with its same-named remote-tracking branches; past the first `keep(all)` the rest
 * collapse into "+N".
 */
export function rowBadges(
  hash: string,
  refs: readonly Ref[],
  snapshot: RefSnapshot,
  keep: (all: readonly Badge[]) => number,
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
    });
  const upstream = headUpstream(snapshot);
  for (const { ref, remotes } of pairRefs(refs, snapshot.remotes))
    all.push(refBadge(hash, ref, remotes, snapshot.headBranch, upstream));
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
  };
  return [...all.slice(0, kept), more];
}

function refBadge(
  hash: string,
  r: Ref,
  remotes: Ref[],
  headBranch: string | undefined,
  upstream: string | undefined,
): Badge {
  const current = r.kind === 'branch' && r.short === headBranch;
  const context: BadgeContext =
    r.kind === 'branch'
      ? {
          webviewSection: 'branch',
          strataHash: hash,
          strataRef: r.name,
          strataIsCurrent: current,
          strataUpstream: r.tracks === true,
        }
      : { webviewSection: r.kind === 'remote' ? 'remoteBranch' : 'tag', strataHash: hash, strataRef: r.name };
  const shown = remotes.length > REMOTES_SHOWN ? remotes.slice(0, REMOTES_SHOWN) : remotes;
  const hidden = remotes.slice(shown.length);
  const names = [r.name, ...remotes.map((x) => x.name)];
  return {
    look: current ? 'head' : r.kind,
    tracked: r.kind === 'remote' && r.name === upstream,
    text: r.short,
    title: names.join('\n'),
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
  };
}

/** The refs of `badges` (not collapsed into "+N") as read: each by its kind, in order. */
export function refsLabel(badges: readonly Badge[]): string {
  return badges
    .map((b) => {
      if (b.context.webviewSection === 'head') return 'detached HEAD';
      const kind =
        b.look === 'head'
          ? 'current branch'
          : b.look === 'remote'
            ? b.tracked
              ? 'upstream'
              : 'remote branch'
            : b.look;
      return `${kind} ${b.text}${b.also.length > 0 ? `, also ${b.also.join(', ')}` : ''}`;
    })
    .join('; ');
}

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

/**
 * Whether a commit's `badges`, as rowBadges laid them out, leave any of its `refs` out of sight:
 * collapsed into "+N" or a branch's "+k" remote names, or given no badge (hidden by a rule).
 */
export function leavesOut(badges: readonly Badge[], refs: readonly Ref[]): boolean {
  const collapsed = (b: Badge) => b.look === 'more' || b.remotes.some((r) => r.context.webviewSection === 'refs');
  if (badges.some(collapsed)) return true;
  const shown = new Set(badges.flatMap((b) => b.refs));
  return refs.some((r) => !shown.has(r.name));
}

/** One line of a commit's ref card. */
export interface CardRef {
  look: Exclude<Badge['look'], 'more'>;
  text: string;
  /** "detached", "current branch" or "upstream". */
  note: string | undefined;
  /** Pattern of the rule hiding its badge. */
  hiddenBy: string | undefined;
}

/**
 * Every ref of one commit for its ref card: a detached HEAD, then `refs` (in badgeOrder) one by
 * one, those whose badges are collapsed into "+N" or hidden by a rule included.
 */
export function cardRefs(
  hash: string,
  refs: readonly Ref[],
  snapshot: RefSnapshot,
  hidden: { get(name: string): { pattern: string } | undefined },
): CardRef[] {
  const upstream = headUpstream(snapshot);
  const head: CardRef[] =
    hash === snapshot.head && snapshot.headBranch === undefined
      ? [{ look: 'head', text: 'HEAD', note: 'detached', hiddenBy: undefined }]
      : [];
  return [
    ...head,
    ...refs.map((r): CardRef => {
      const current = r.kind === 'branch' && r.short === snapshot.headBranch;
      return {
        look: current ? 'head' : r.kind,
        text: r.short,
        note: current ? 'current branch' : r.name === upstream ? 'upstream' : undefined,
        hiddenBy: hidden.get(r.name)?.pattern,
      };
    }),
  ];
}
