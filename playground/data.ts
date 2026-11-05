// Generates playground data from fixture repositories with the real git readers:
// out/playground/data/<scenario>.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Commit } from '../src/core/commit.ts';
import type { CommitDetails } from '../src/core/details.ts';
import type { Where } from '../src/core/where.ts';
import { readCommitDetails } from '../src/git/details.ts';
import { LogReader } from '../src/git/log-reader.ts';
import { changingCommits, readPathOrigin } from '../src/git/path-history.ts';
import { parsePathFilter } from '../src/core/path-filter.ts';
import { readRefs } from '../src/git/refs.ts';
import { readStashDetails, readStashes } from '../src/git/stash.ts';
import { readWhere } from '../src/git/where.ts';
import { scenarios, type ScenarioName } from '../test/fixtures/scenarios.ts';
import type { PlaygroundData } from './types.ts';

const NAMES: ScenarioName[] = ['branchy', 'stashes', 'octopus', 'multi-root', 'refs', 'messages', 'paths', 'large'];
/** Path histories the playground can show (?path=a,b), by scenario. */
const PATHS: Partial<Record<ScenarioName, string[][]>> = {
  paths: [['src/auth/session.ts'], ['src/auth/session.ts', 'src/session.ts'], ['src/auth/']],
};
const DETAILS = 40;

const out = join('out', 'playground', 'data');
mkdirSync(out, { recursive: true });
for (const name of NAMES) {
  const dir = join('out', 'fixtures', name);
  scenarios[name]().write(dir);
  const reader = new LogReader({ git: 'git', cwd: dir });
  const commits: Commit[] = (await reader.next(1_000_000)).commits;
  reader.dispose();
  const stashes = await readStashes('git', dir);
  const refs = await readRefs('git', dir);
  const details: Record<string, CommitDetails> = {};
  const where: Record<string, Where> = {};
  for (const c of commits.slice(0, DETAILS)) {
    details[c.hash] = await readCommitDetails('git', dir, c.hash);
    where[c.hash] = await readWhere('git', dir, c.hash, refs, new Set(), {});
  }
  for (const s of stashes) details[s.hash] = await readStashDetails('git', dir, s.hash);
  const paths: NonNullable<PlaygroundData['paths']> = {};
  for (const list of PATHS[name] ?? []) {
    const filter = parsePathFilter({ paths: list })!;
    const r = new LogReader({ git: 'git', cwd: dir, paths: filter.paths });
    const history = (await r.next(1_000_000)).commits;
    r.dispose();
    const tips = new Set([...refs.refs.filter((x) => x.kind !== 'tag').map((x) => x.hash), refs.head]);
    const kept = history.filter((c) => tips.has(c.hash) || c.parents.length > 1).map((c) => c.hash);
    const changing = await changingCommits('git', dir, kept, filter);
    const unchanged = kept.filter((h) => !changing.has(h));
    const oldest = history.findLast((c) => !unchanged.includes(c.hash))!;
    const origin = await readPathOrigin('git', dir, oldest.hash, filter, false);
    for (const c of history) details[c.hash] ??= await readCommitDetails('git', dir, c.hash);
    paths[list.join(',')] = { commits: history, unchanged, origin };
  }
  const data: PlaygroundData = { repo: { name, root: dir }, refs, stashes, commits, details, where, paths };
  writeFileSync(join(out, `${name}.json`), JSON.stringify(data));
}
