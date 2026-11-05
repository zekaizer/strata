export type RefKind = 'branch' | 'remote' | 'tag';

export interface Ref {
  /** Full name, e.g. refs/heads/main. */
  name: string;
  /** Display name, e.g. main, origin/main, v1.0. */
  short: string;
  kind: RefKind;
  /** Commit the ref points at (annotated tags are peeled). */
  hash: string;
  /** A local branch's upstream remote-tracking branch, full name (refs/remotes/origin/main); absent without one. */
  upstream?: string;
  /**
   * A local branch with an upstream configured, as `git pull` reads it; true also for a URL remote
   * or a branch the remote's refspec leaves out, which have no `upstream`.
   */
  tracks?: true;
}

export interface RefSnapshot {
  /** Commit HEAD points at; undefined on an unborn branch. */
  head: string | undefined;
  /** Branch HEAD is on (short name); undefined when detached or unborn. */
  headBranch: string | undefined;
  refs: Ref[];
  /** Names of the configured remotes (`git remote`). */
  remotes: string[];
}

/** The current branch's upstream, full name; undefined when detached or without one. */
export function headUpstream(snapshot: RefSnapshot): string | undefined {
  if (snapshot.headBranch === undefined) return undefined;
  return snapshot.refs.find((r) => r.kind === 'branch' && r.short === snapshot.headBranch)?.upstream;
}

const KIND_ORDER: Record<RefKind, number> = { branch: 0, remote: 1, tag: 2 };

/**
 * Order of the badges on one commit: the current branch, then its upstream (`upstream`: full
 * name), then refs picked in the ref filter (`picked`: full names, null for all), then the rest;
 * within each group branches, remotes, tags, and by name.
 */
export function badgeOrder(
  refs: readonly Ref[],
  headBranch: string | undefined,
  upstream: string | undefined,
  picked: readonly string[] | null,
): Ref[] {
  const chosen = new Set(picked ?? []);
  const group = (r: Ref) =>
    r.kind === 'branch' && r.short === headBranch ? 0 : r.name === upstream ? 1 : chosen.has(r.name) ? 2 : 3;
  return [...refs].sort(
    (a, b) => group(a) - group(b) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.short.localeCompare(b.short),
  );
}

/** A badge: a ref, plus the remote-tracking branches of the same name on the same commit. */
export interface BadgeRefs {
  ref: Ref;
  /** Remote-tracking refs merged into a local branch's badge, e.g. origin/main into main. */
  remotes: Ref[];
}

/**
 * Merges each local branch with its same-named remote-tracking branches (`<remote>/<branch>` for a
 * known remote) on one commit. `refs` are one commit's refs in display order; a merged badge takes
 * the place of its earliest member. Differently named upstreams stay separate.
 */
export function pairRefs(refs: readonly Ref[], remotes: readonly string[]): BadgeRefs[] {
  // Longest remote first: refs/remotes/team/x/main is remote "team/x", not "team" with branch "x/main".
  const known = [...remotes].sort((a, b) => b.length - a.length);
  const branchOf = (r: Ref): string | undefined => {
    for (const remote of known) {
      const prefix = `refs/remotes/${remote}/`;
      if (r.name.startsWith(prefix)) {
        const branch = r.name.slice(prefix.length);
        return branch === 'HEAD' ? undefined : branch;
      }
    }
    return undefined;
  };
  const locals = new Map(refs.filter((r) => r.kind === 'branch').map((r) => [r.short, r]));
  /** Remote-tracking ref -> the local branch it merges into. */
  const owner = new Map<Ref, Ref>();
  for (const r of refs) {
    if (r.kind !== 'remote') continue;
    const branch = branchOf(r);
    const local = branch === undefined ? undefined : locals.get(branch);
    if (local) owner.set(r, local);
  }
  const out: BadgeRefs[] = [];
  const byLocal = new Map<Ref, BadgeRefs>();
  for (const r of refs) {
    const local = owner.get(r) ?? r;
    let badge = byLocal.get(local);
    if (!badge) {
      badge = { ref: local, remotes: [] };
      byLocal.set(local, badge);
      out.push(badge);
    }
    if (local !== r) badge.remotes.push(r);
  }
  return out;
}
