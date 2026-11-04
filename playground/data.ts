// Generates playground data from fixture repositories with the real git readers:
// out/playground/data/<scenario>.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Commit } from '../src/core/commit.ts';
import type { CommitDetails } from '../src/core/details.ts';
import { readCommitDetails } from '../src/git/details.ts';
import { LogReader } from '../src/git/log-reader.ts';
import { readRefs } from '../src/git/refs.ts';
import { readStashes } from '../src/git/stash.ts';
import { scenarios, type ScenarioName } from '../test/fixtures/scenarios.ts';
import type { PlaygroundData } from './types.ts';

const NAMES: ScenarioName[] = ['branchy', 'stashes', 'octopus', 'multi-root', 'refs', 'messages', 'large'];
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
  const details: Record<string, CommitDetails> = {};
  for (const c of commits.slice(0, DETAILS)) details[c.hash] = await readCommitDetails('git', dir, c.hash);
  for (const s of stashes) details[s.hash] = await readCommitDetails('git', dir, s.hash);
  const data: PlaygroundData = {
    repo: { name, root: dir },
    refs: await readRefs('git', dir),
    stashes,
    commits,
    details,
  };
  writeFileSync(join(out, `${name}.json`), JSON.stringify(data));
}
