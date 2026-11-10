import type { WorktreeInfo } from './worktrees.ts';

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
  /** The repository's other worktrees: every one but the graph's, in `git worktree list` order. */
  worktrees: WorktreeInfo[];
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

/** A badge: a ref, plus its same-named upstream when on the same commit. */
export interface BadgeRefs {
  ref: Ref;
  /** A local branch's upstream merged into its badge: origin/main into main. */
  remote: Ref | undefined;
}

/**
 * Merges each local branch with its upstream on one commit when the upstream has the branch's name
 * (`<remote>/<branch>` for a known remote): only the upstream says whether the branch is pushed.
 * `refs` are one commit's refs in display order; a merged badge takes the place of its earliest
 * member. Differently named upstreams and other remotes' same-named branches stay separate.
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
    if (local?.upstream === r.name) owner.set(r, local);
  }
  const out: BadgeRefs[] = [];
  const byLocal = new Map<Ref, BadgeRefs>();
  for (const r of refs) {
    const local = owner.get(r) ?? r;
    let badge = byLocal.get(local);
    if (!badge) {
      badge = { ref: local, remote: undefined };
      byLocal.set(local, badge);
      out.push(badge);
    }
    if (local !== r) badge.remote = r;
  }
  return out;
}

/**
 * The commits a view's history is read from, as viewArgs gives them to git: the refs picked in
 * the filter (`refs`), else every branch and remote-tracking branch, HEAD and the other
 * worktrees' detached HEADs. A path history (`path`) keeps HEAD's commit for its badge too.
 */
export function historyStarts(snapshot: RefSnapshot, refs: readonly string[] | null, path: boolean): Set<string> {
  const picked = (r: Ref) => (refs ? refs.includes(r.name) : r.kind !== 'tag');
  const starts = new Set(snapshot.refs.filter(picked).map((r) => r.hash));
  if (snapshot.head !== undefined && (refs === null || path)) starts.add(snapshot.head);
  if (refs === null)
    for (const w of snapshot.worktrees) if (w.branch === undefined && w.head !== undefined) starts.add(w.head);
  return starts;
}

/** What a change of a view's starts does to its history; `check`: see historyChange. */
export type HistoryChange =
  { kind: 'same' } | { kind: 'check'; added: string[]; removed: string[] } | { kind: 'reload' };

/**
 * Whether the history read from starts `before` stays the same read from `after`, given commits
 * known to be in it (`served`): `same` for certain; `check` when it does if every `added` commit is
 * an ancestor of `before` and every `removed` one of `after`; `reload` when that does not tell. A
 * path history keeps its start commits as rows, and a first-parent history reaches along first
 * parents only, which ancestry does not answer.
 */
export function historyChange(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
  served: ReadonlySet<string>,
  view: { firstParent: boolean; path: boolean },
): HistoryChange {
  const added = [...after].filter((h) => !before.has(h));
  const removed = [...before].filter((h) => !after.has(h));
  if (added.length === 0 && removed.length === 0) return { kind: 'same' };
  if (view.path) return { kind: 'reload' };
  const unknown = added.filter((h) => !served.has(h));
  if (unknown.length === 0 && removed.length === 0) return { kind: 'same' };
  if (view.firstParent) return { kind: 'reload' };
  return { kind: 'check', added: unknown, removed };
}
