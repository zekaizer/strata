export type RefKind = 'branch' | 'remote' | 'tag' | 'stash';

export interface Ref {
  /** Full name, e.g. refs/heads/main. */
  name: string;
  /** Display name, e.g. main, origin/main, v1.0. */
  short: string;
  kind: RefKind;
  /** Commit the ref points at (annotated tags are peeled). */
  hash: string;
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

const KIND_ORDER: Record<RefKind, number> = { branch: 0, remote: 1, tag: 2, stash: 3 };

/**
 * Order of the badges on one commit: the current branch, then refs picked in the ref filter
 * (`picked`: full names, null for all), then the rest; within each group branches, remotes,
 * tags, stashes, and by name.
 */
export function badgeOrder(
  refs: readonly Ref[],
  headBranch: string | undefined,
  picked: readonly string[] | null,
): Ref[] {
  const chosen = new Set(picked ?? []);
  const group = (r: Ref) => (r.kind === 'branch' && r.short === headBranch ? 0 : chosen.has(r.name) ? 1 : 2);
  return [...refs].sort(
    (a, b) => group(a) - group(b) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.short.localeCompare(b.short),
  );
}
