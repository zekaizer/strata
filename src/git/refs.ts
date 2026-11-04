import type { Ref, RefKind, RefSnapshot } from '../core/refs.ts';
import { runGit } from './run.ts';

const PREFIXES: [string, RefKind][] = [
  ['refs/heads/', 'branch'],
  ['refs/remotes/', 'remote'],
  ['refs/tags/', 'tag'],
];

/**
 * Reads HEAD, the remotes, and all branch, remote-tracking and tag refs pointing (after peeling) at
 * commits. Stashes are read on their own (readStashes).
 */
export async function readRefs(git: string, cwd: string): Promise<RefSnapshot> {
  const format = '%(refname)%00%(objecttype)%00%(objectname)%00%(*objecttype)%00%(*objectname)%00%(symref)';
  const [list, headBranch, head, remotes] = await Promise.all([
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
  ]);
  const refs: Ref[] = [];
  // Ref names cannot contain NUL or newline, so one ref per line is unambiguous.
  for (const line of list.split('\n')) {
    if (!line) continue;
    const [name, type, hash, peeledType, peeledHash, symref] = line.split('\0') as [
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
    refs.push({ name, short: name.slice(match[0].length), kind: match[1], hash: target.hash });
  }
  return { head, headBranch, refs, remotes };
}
