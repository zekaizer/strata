import type { Ref, RefSnapshot } from './refs.ts';

/** Branches the On line names before "+N". */
export const ON_MAX = 3;

/**
 * Where a commit is, as its ref card says below its refs. A line git could not answer within its
 * time budget, or was not asked, is absent.
 */
export interface Where {
  on?: OnLine;
  /** The first tag holding the commit; null when no tag the card may name holds it. */
  firstIn?: string | null;
  /** The nearest tag the commit comes after, and how many commits after it; absent with none. */
  after?: { tag: string; commits: number };
}

/** The branches and remote-tracking branches holding a commit. */
export interface OnLine {
  /** At most ON_MAX: the current branch, then local branches, then remote-tracking ones, by name. */
  refs: Ref[];
  /** Further branches not listed. */
  more: number;
  /** Branches holding it whose badges the rules hide, counted in neither of the above. */
  hidden: number;
}

/** What to ask git about a commit for its card. Tags are short names. */
export interface WhereAsk {
  /** Tags whose badges the rules hide: no line names them. */
  hidden: string[];
  /** Tags on the commit itself: After names an earlier one. */
  own: string[];
  /** Off when no tag may be named, or the commit carries one that may: First in would name that one. */
  firstIn: boolean;
  /** Off when every tag that may be named is on the commit. */
  after: boolean;
}

/** `hidden`: full names of the refs whose badges the rules hide. */
export function whereAsk(snapshot: RefSnapshot, hidden: { has(name: string): boolean }, hash: string): WhereAsk {
  const tags = snapshot.refs.filter((r) => r.kind === 'tag');
  const shown = tags.filter((r) => !hidden.has(r.name));
  return {
    hidden: tags.filter((r) => hidden.has(r.name)).map((r) => r.short),
    own: tags.filter((r) => r.hash === hash).map((r) => r.short),
    firstIn: shown.length > 0 && !shown.some((r) => r.hash === hash),
    after: shown.some((r) => r.hash !== hash),
  };
}

const ON_ORDER = (r: Ref, headBranch: string | undefined): number =>
  r.kind === 'branch' && r.short === headBranch ? 0 : r.kind === 'branch' ? 1 : 2;

/**
 * The On line from `git for-each-ref --format=%(refname) refs/heads refs/remotes` output. Refs the
 * snapshot lacks (symbolic ones such as origin/HEAD) are left out.
 */
export function parseOn(out: string, snapshot: RefSnapshot, hidden: { has(name: string): boolean }): OnLine {
  const byName = new Map(snapshot.refs.map((r) => [r.name, r]));
  const holding = out
    .split('\n')
    .map((name) => byName.get(name))
    .filter((r): r is Ref => r !== undefined && r.kind !== 'tag');
  const shown = holding
    .filter((r) => !hidden.has(r.name))
    .sort(
      (a, b) => ON_ORDER(a, snapshot.headBranch) - ON_ORDER(b, snapshot.headBranch) || a.short.localeCompare(b.short),
    );
  return {
    refs: shown.slice(0, ON_MAX),
    more: Math.max(0, shown.length - ON_MAX),
    hidden: holding.length - shown.length,
  };
}

/**
 * First in from `git name-rev --name-only --tags` output: "v1.2~3^2~1" names tag v1.2 (ref names
 * cannot hold `~` or `^`); "undefined" says no tag holds the commit.
 */
export function parseFirstIn(out: string): string | null {
  const name = out.trim();
  return name === 'undefined' || name === '' ? null : name.replace(/[~^].*$/, '');
}

/** After from `git describe --tags --long` output, `<tag>-<commits>-g<abbreviated hash>`. */
export function parseAfter(out: string): { tag: string; commits: number } | undefined {
  const m = /^(.+)-(\d+)-g[0-9a-f]+$/.exec(out.trim());
  return m ? { tag: m[1]!, commits: Number(m[2]) } : undefined;
}
