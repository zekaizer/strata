declare const repoKeyBrand: unique symbol;

/**
 * A repository's identity: the file system path of its root. vscode.git hands out a new wrapper
 * object for a repository on every access, so wrappers are never compared.
 */
export type RepoKey = string & { readonly [repoKeyBrand]: true };

/** VS Code's scm.repositories.sortOrder. */
export type RepoSortOrder = 'discoveryTime' | 'name' | 'path';

/**
 * What decides the repository the graph shows, strongest first: the one the user chose, the one
 * the panel showed last (restored from its saved state), the one it shows now, and the active
 * editor's. Any of them may name a repository that is not open, or come from the webview.
 */
export interface RepoPreference {
  chosen?: string | undefined;
  restored?: string | undefined;
  shown?: string | undefined;
  active?: string | undefined;
}

/** The open repository to show: the strongest preference that is open, else the first of the list. */
export function pickRepo(open: readonly RepoKey[], p: RepoPreference): RepoKey | undefined {
  for (const want of [p.chosen, p.restored, p.shown, p.active]) {
    const key = open.find((k) => k === want);
    if (key !== undefined) return key;
  }
  return open[0];
}

export interface Listed {
  key: RepoKey;
  /** The root folder's name. */
  name: string;
}

/**
 * Repositories in the order VS Code's Source Control view lists them. `seen` numbers each
 * repository in the order it was first seen, which stands for discovery time: vscode.git sorts
 * its own list in place.
 */
export function sortRepos<T extends Listed>(
  repos: readonly T[],
  order: RepoSortOrder,
  seen: ReadonlyMap<RepoKey, number>,
): T[] {
  const byPath = (a: T, b: T) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const compare: Record<RepoSortOrder, (a: T, b: T) => number> = {
    discoveryTime: (a, b) => (seen.get(a.key) ?? Infinity) - (seen.get(b.key) ?? Infinity) || byPath(a, b),
    name: (a, b) => a.name.localeCompare(b.name) || byPath(a, b),
    path: byPath,
  };
  return [...repos].sort(compare[order]);
}

/** `raw`, from outside the host (the webview, a command argument), as the key of one of the `open` repositories. */
export function parseRepoKey(raw: unknown, open: readonly RepoKey[]): RepoKey | undefined {
  return open.find((k) => k === raw);
}
