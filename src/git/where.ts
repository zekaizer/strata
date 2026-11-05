import type { RefSnapshot } from '../core/refs.ts';
import { parseAfter, parseFirstIn, parseOn, whereAsk, type Where } from '../core/where.ts';
import { runGit, type GitLimits } from './run.ts';

/**
 * Where commit `hash` is, from three git queries run side by side, each stopped by `limits`. A
 * query that fails or is stopped leaves its line out. `hidden`: full names of the refs whose
 * badges the rules hide.
 */
export async function readWhere(
  git: string,
  cwd: string,
  hash: string,
  snapshot: RefSnapshot,
  hidden: { has(name: string): boolean },
  limits: GitLimits,
): Promise<Where> {
  const ask = whereAsk(snapshot, hidden, hash);
  const run = (args: string[]) => runGit(git, cwd, args, {}, limits).catch(() => undefined);
  // Tag names cannot hold glob characters, so each is a pattern matching that tag only.
  const [on, firstIn, after] = await Promise.all([
    run(['for-each-ref', `--contains=${hash}`, '--format=%(refname)', 'refs/heads', 'refs/remotes']),
    // What `git describe --contains` runs, but it prints "undefined" for no tag instead of failing.
    ask.firstIn
      ? run(['name-rev', '--name-only', '--tags', ...ask.hidden.map((t) => `--exclude=refs/tags/${t}`), hash])
      : undefined,
    ask.after
      ? run(['describe', '--tags', '--long', ...[...ask.hidden, ...ask.own].map((t) => `--exclude=${t}`), hash])
      : undefined,
  ]);
  const since = after === undefined ? undefined : parseAfter(after);
  return {
    ...(on === undefined ? {} : { on: parseOn(on, snapshot, hidden) }),
    ...(firstIn === undefined ? {} : { firstIn: parseFirstIn(firstIn) }),
    ...(since === undefined ? {} : { after: since }),
  };
}
