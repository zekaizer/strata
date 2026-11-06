import type { Ref, RefKind, RefSnapshot } from '../core/refs.ts';
import { configuredUpstream, readBranchConfigs, readWorktrees } from './facts.ts';
import { runGit } from './run.ts';

const PREFIXES: [string, RefKind][] = [
  ['refs/heads/', 'branch'],
  ['refs/remotes/', 'remote'],
  ['refs/tags/', 'tag'],
];

/**
 * Reads HEAD, the remotes, all branch, remote-tracking and tag refs pointing (after peeling) at
 * commits, and the other worktrees. Stashes are read on their own (readStashes).
 */
export async function readRefs(git: string, cwd: string): Promise<RefSnapshot> {
  const format =
    '%(refname)%00%(objecttype)%00%(objectname)%00%(*objecttype)%00%(*objectname)%00%(symref)%00%(upstream)';
  const [list, headBranch, head, remotes, config, worktrees] = await Promise.all([
    runGit(git, cwd, ['for-each-ref', `--format=${format}`, 'refs/heads', 'refs/remotes', 'refs/tags']),
    // Exit status 1 means detached HEAD.
    runGit(git, cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).then(
      (s) => s.trim() || undefined,
      () => undefined,
    ),
    // Fails on an unborn branch.
    runGit(git, cwd, ['rev-parse', '--quiet', '--verify', 'HEAD^{commit}']).then(
      (s) => s.trim() || undefined,
      () => undefined,
    ),
    runGit(git, cwd, ['remote']).then((s) => s.split('\n').filter(Boolean)),
    readBranchConfigs(git, cwd),
    readWorktrees(git, cwd),
  ]);
  const refs: Ref[] = [];
  // Ref names cannot contain NUL or newline, so one ref per line is unambiguous.
  for (const line of list.split('\n')) {
    if (!line) continue;
    const [name, type, hash, peeledType, peeledHash, symref, upstream] = line.split('\0') as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (symref) continue;
    const target = peeledType ? { type: peeledType, hash: peeledHash } : { type, hash };
    if (target.type !== 'commit') continue;
    const match = PREFIXES.find(([p]) => name.startsWith(p));
    if (!match) continue;
    const short = name.slice(match[0].length);
    const tracks = match[1] === 'branch' && configuredUpstream(config.get(short) ?? [], short) !== undefined;
    refs.push({
      name,
      short,
      kind: match[1],
      hash: target.hash,
      ...(upstream ? { upstream } : {}),
      ...(tracks ? { tracks: true } : {}),
    });
  }
  return { head, headBranch, refs, remotes, worktrees };
}

/** Whether every commit of `commits` is `from` or an ancestor of one of them; false when git cannot tell. */
export async function allReachable(
  git: string,
  cwd: string,
  commits: readonly string[],
  from: readonly string[],
): Promise<boolean> {
  if (commits.length === 0) return true;
  const out = await runGit(git, cwd, ['rev-list', '-1', ...commits, '--not', ...from, '--']).catch(() => undefined);
  return out === '';
}
