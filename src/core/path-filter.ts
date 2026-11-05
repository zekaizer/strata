declare const repoPathBrand: unique symbol;

/** Repository-relative, '/'-separated, without '.' or '..' segments; a folder ends with '/'. */
export type RepoPath = string & { readonly [repoPathBrand]: true };

/** The history shown is that of these paths: commits that change any of them. */
export interface PathFilter {
  /** paths[0] is what the user picked; later entries are older names added from a rename note. */
  readonly paths: readonly [RepoPath, ...RepoPath[]];
}

/** More paths than this are refused: each is a pathspec git matches every commit's changes against. */
export const MAX_FILTER_PATHS = 32;

/** A file path as git prints it: '/'-separated, no empty, '.' or '..' segments. */
export function isRepoPath(p: string): boolean {
  return (
    p.length > 0 &&
    !p.includes('\0') &&
    !p.includes('\\') &&
    p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
  );
}

/** `raw` as a file or folder path of the filter; undefined when it is neither. */
export function parseRepoPath(raw: unknown): RepoPath | undefined {
  if (typeof raw !== 'string') return undefined;
  const file = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  return isRepoPath(file) ? (raw as RepoPath) : undefined;
}

/** `raw` (from saved state, the webview or a command) as a filter; undefined when it names no valid path. */
export function parsePathFilter(raw: unknown): PathFilter | undefined {
  const list = typeof raw === 'object' && raw !== null ? (raw as { paths?: unknown }).paths : undefined;
  if (!Array.isArray(list) || list.length > MAX_FILTER_PATHS) return undefined;
  const paths: RepoPath[] = [];
  for (const p of list) {
    const path = parseRepoPath(p);
    if (path === undefined) return undefined;
    if (!paths.includes(path)) paths.push(path);
  }
  const [first, ...rest] = paths;
  return first === undefined ? undefined : { paths: [first, ...rest] };
}

export const isFolder = (p: RepoPath): boolean => p.endsWith('/');

/** Whether the changed file `file` is one of the filter's paths or inside one of its folders. */
export function inFilter(file: string, f: PathFilter): boolean {
  return f.paths.some((p) => (isFolder(p) ? file.startsWith(p) : file === p));
}

/** The file or folder name: "session.ts", "auth/". */
export function pathName(p: RepoPath): string {
  const trimmed = isFolder(p) ? p.slice(0, -1) : p;
  return `${trimmed.slice(trimmed.lastIndexOf('/') + 1)}${isFolder(p) ? '/' : ''}`;
}

/** The toolbar chip's text: the picked path's name, and how many older names were added. */
export function pathLabel(f: PathFilter): string {
  const more = f.paths.length - 1;
  return more > 0 ? `${pathName(f.paths[0])} +${more}` : pathName(f.paths[0]);
}

/** `f` with `path` added (an older name); unchanged when it has it or is full. */
export function withPath(f: PathFilter, path: RepoPath): PathFilter {
  if (f.paths.includes(path) || f.paths.length >= MAX_FILTER_PATHS) return f;
  return { paths: [...f.paths, path] };
}

/** The folder holding `p`, as a filter path; undefined at the repository root. */
export function parentFolder(p: RepoPath): RepoPath | undefined {
  const trimmed = isFolder(p) ? p.slice(0, -1) : p;
  const at = trimmed.lastIndexOf('/');
  return at < 0 ? undefined : (trimmed.slice(0, at + 1) as RepoPath);
}

export const samePathFilter = (a: PathFilter | null, b: PathFilter | null): boolean =>
  JSON.stringify(a?.paths ?? null) === JSON.stringify(b?.paths ?? null);

/**
 * How a path's history starts, found once all of it is read. `renamed`: the oldest commit that
 * changes it made `to` (a filter path) by renaming `from`. `added`: it created it; `exactOnly`
 * when only renames that keep the content were looked for (a partial clone, whose blobs git would
 * have to download). `never`: no commit changes it; `tracked` when the index has it (added, not
 * committed yet).
 */
export type PathOrigin =
  | { kind: 'renamed'; hash: string; from: RepoPath; to: RepoPath }
  | { kind: 'added'; hash: string; exactOnly: boolean }
  | { kind: 'never'; tracked: boolean };
