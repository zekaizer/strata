import { pairRefs, type Ref, type RefSnapshot } from '../core/refs.ts';
import type { BadgeContext } from '../shared/menu-context.ts';

/** Badges shown in a row's ref band; the rest collapse into a "+N" badge. */
export const MAX_BADGES = 6;
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
  title: string;
  /** Full names of the refs it stands for, merged remote names and "+N" contents included. */
  refs: string[];
  /** A branch's same-named remote-tracking branches: a target per name shown, then "+k" for the rest. */
  remotes: Target[];
  /** Short names of those remote-tracking branches, for screen readers. */
  also: string[];
}

/**
 * The badges of one commit: a detached HEAD, then `refs` (in badgeOrder) with each local branch
 * merged with its same-named remote-tracking branches; past MAX_BADGES the rest collapse into "+N".
 */
export function rowBadges(hash: string, refs: readonly Ref[], snapshot: RefSnapshot): Badge[] {
  const all: Badge[] = [];
  if (hash === snapshot.head && snapshot.headBranch === undefined)
    all.push({
      look: 'head',
      text: 'HEAD',
      title: 'Detached HEAD',
      context: { webviewSection: 'head', strataHash: hash },
      refs: [],
      remotes: [],
      also: [],
    });
  for (const { ref, remotes } of pairRefs(refs, snapshot.remotes))
    all.push(refBadge(hash, ref, remotes, snapshot.headBranch));
  if (all.length <= MAX_BADGES) return all;
  const rest = all.slice(MAX_BADGES - 1);
  const names = rest.flatMap((b) => b.refs);
  const more: Badge = {
    look: 'more',
    text: `+${rest.length}`,
    title: rest.map((b) => (b.also.length > 0 ? `${b.text} (also ${b.also.join(', ')})` : b.title)).join('\n'),
    context: { webviewSection: 'refs', strataHash: hash, strataRefs: names.join(' ') },
    refs: names,
    remotes: [],
    also: [],
  };
  return [...all.slice(0, MAX_BADGES - 1), more];
}

function refBadge(hash: string, r: Ref, remotes: Ref[], headBranch: string | undefined): Badge {
  const current = r.kind === 'branch' && r.short === headBranch;
  const context: BadgeContext =
    r.kind === 'branch'
      ? {
          webviewSection: 'branch',
          strataHash: hash,
          strataRef: r.name,
          strataIsCurrent: current,
          strataUpstream: r.upstream !== undefined,
        }
      : { webviewSection: r.kind === 'remote' ? 'remoteBranch' : 'tag', strataHash: hash, strataRef: r.name };
  const shown = remotes.length > REMOTES_SHOWN ? remotes.slice(0, REMOTES_SHOWN) : remotes;
  const hidden = remotes.slice(shown.length);
  const names = [r.name, ...remotes.map((x) => x.name)];
  return {
    look: current ? 'head' : r.kind,
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
