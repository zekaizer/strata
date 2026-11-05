import { inFilter, parseRepoPath, type PathFilter, type PathOrigin, type RepoPath } from '../core/path-filter.ts';
import { runGit } from './run.ts';

/**
 * Which of `hashes` change the filter's paths, by the rule `git log` applies to the history: a
 * merge counts only when it differs from every parent (with `firstParent`, from its first). Used
 * for the commits a path history keeps only for the graph.
 */
export async function changingCommits(
  git: string,
  cwd: string,
  hashes: readonly string[],
  filter: PathFilter,
  firstParent = false,
): Promise<Set<string>> {
  if (hashes.length === 0) return new Set();
  const out = await runGit(git, cwd, [
    '--literal-pathspecs',
    'log',
    '--no-walk=unsorted',
    ...(firstParent ? ['--first-parent'] : []),
    '--format=%H',
    ...hashes,
    '--',
    ...filter.paths,
  ]);
  return new Set(out.split('\n').filter(Boolean));
}

/** Whether objects are fetched on demand (a partial clone): reading a missing blob would download it. */
export async function isPartialClone(git: string, cwd: string): Promise<boolean> {
  const out = await runGit(git, cwd, [
    'config',
    '--get-regexp',
    String.raw`^(remote\..*\.promisor|extensions\.partialclone)$`,
  ]).catch(() => '');
  return out
    .split('\n')
    .filter(Boolean)
    .some((line) => !/^remote\..*\.promisor\s+false$/i.test(line));
}

interface RawChange {
  status: string;
  oid: string;
  oldOid: string;
  path: string;
  oldPath: string | undefined;
}

/** `git diff-tree -z --raw` entries of the first commit listed (with -m, of its first parent). */
function parseRaw(out: string): RawChange[] {
  const t = out.split('\0');
  const changes: RawChange[] = [];
  let i = t[0] !== undefined && /^[0-9a-f]{40,64}$/.test(t[0]) ? 1 : 0;
  while (i < t.length && t[i]!.startsWith(':')) {
    const [, , oldOid = '', oid = '', status = ''] = t[i]!.slice(1).split(' ');
    const renamed = status.startsWith('R') || status.startsWith('C');
    const first = t[i + 1] ?? '';
    const second = renamed ? (t[i + 2] ?? '') : undefined;
    changes.push({
      status: status.charAt(0),
      oid,
      oldOid,
      path: second ?? first,
      oldPath: renamed ? first : undefined,
    });
    i += renamed ? 3 : 2;
  }
  return changes;
}

/** The deepest folder holding every path, as a filter path; undefined when that is the root. */
function commonFolder(paths: readonly string[]): RepoPath | undefined {
  const dirs = paths.map((p) => p.split('/').slice(0, -1));
  const first = dirs[0] ?? [];
  let n = first.length;
  for (const d of dirs) {
    let k = 0;
    while (k < n && k < d.length && d[k] === first[k]) k++;
    n = k;
  }
  return n === 0 ? undefined : parseRepoPath(`${first.slice(0, n).join('/')}/`);
}

/**
 * How the history of the filter's paths starts at `hash`, its oldest commit changing them: which
 * filter path it made by renaming another path, if any. In a partial clone only renames that keep
 * the content are found, from the object ids: comparing contents would download blobs.
 */
export async function readPathOrigin(
  git: string,
  cwd: string,
  hash: string,
  filter: PathFilter,
  exactOnly: boolean,
): Promise<PathOrigin> {
  const out = await runGit(git, cwd, [
    'diff-tree',
    '-r',
    '-z',
    '--raw',
    '--no-abbrev',
    '--root',
    '-m',
    exactOnly ? '--no-renames' : '-M',
    hash,
  ]);
  const changes = parseRaw(out);
  if (exactOnly) {
    // Deleted files whose content an added file has: a rename git was not asked to detect.
    const deleted = new Map(changes.filter((c) => c.status === 'D').map((c) => [c.oldOid, c.path]));
    for (const c of changes) {
      const from = c.status === 'A' ? deleted.get(c.oid) : undefined;
      if (from !== undefined) Object.assign(c, { status: 'R', oldPath: from });
    }
  }
  const into = changes.filter(
    (c) => c.status === 'R' && inFilter(c.path, filter) && c.oldPath !== undefined && !inFilter(c.oldPath, filter),
  );
  for (const to of filter.paths) {
    const moved = to.endsWith('/') ? into.filter((c) => c.path.startsWith(to)) : into.filter((c) => c.path === to);
    if (moved.length === 0) continue;
    const from = to.endsWith('/') ? commonFolder(moved.map((c) => c.oldPath!)) : parseRepoPath(moved[0]!.oldPath);
    if (from !== undefined && !filter.paths.includes(from)) return { kind: 'renamed', hash, from, to };
  }
  return { kind: 'added', hash, exactOnly };
}

/** Whether the index has any of the filter's paths (a file added but not committed yet). */
export async function isTracked(git: string, cwd: string, filter: PathFilter): Promise<boolean> {
  const out = await runGit(git, cwd, ['--literal-pathspecs', 'ls-files', '-z', '--', ...filter.paths]);
  return out.length > 0;
}
