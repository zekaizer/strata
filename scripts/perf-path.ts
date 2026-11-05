// Measures path (file and folder) history on a real repository without a commit-graph, with one,
// and with one holding changed-path filters. It rewrites the repository's commit-graph: run it on
// a clone (git clone --mirror --shared <repo> <scratch>). Usage:
//   node scripts/perf-path.ts <repo> [runs] [path ...]
// Prints a JSON summary; numbers are copied into docs/PERFORMANCE.md by hand.
import { execFileSync } from 'node:child_process';
import { cpus } from 'node:os';
import { parsePathFilter } from '../src/core/path-filter.ts';
import { LogReader } from '../src/git/log-reader.ts';
import { changingCommits } from '../src/git/path-history.ts';

const [repo = '', runsArg = '5', ...pathArgs] = process.argv.slice(2);
if (repo === '') throw new Error('usage: node scripts/perf-path.ts <repo> [runs] [path ...]');
const runs = Number(runsArg);
const paths =
  pathArgs.length > 0 ? pathArgs : ['LICENSE', 'include/zephyr/kernel.h', 'kernel/sched.c', 'drivers/gpio/'];
/** As the host serves a path history: pages of the webview's sizes, flushed after 150 ms. */
const FIRST_PAGE = 300;
const NEXT_PAGE = 1000;
const FLUSH_MS = 150;

const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 30 });
const tips = new Set(
  git('for-each-ref', '--format=%(objectname)', 'refs/heads', 'refs/remotes').split('\n').filter(Boolean),
);
tips.add(git('rev-parse', 'HEAD').trim());
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** One path history read as the graph reads it: when its first row arrives, and when it is done. */
async function readOnce(
  path: string,
): Promise<{ firstRowMs: number; doneMs: number; rows: number; tipCheckMs: number }> {
  const filter = parsePathFilter({ paths: [path] })!;
  const started = performance.now();
  const r = new LogReader({ git: 'git', cwd: repo, paths: filter.paths });
  let firstRowMs = -1;
  let rows = 0;
  let tipCheckMs = 0;
  try {
    for (let count = FIRST_PAGE; ; count = NEXT_PAGE) {
      const page = await r.next(count, { flushAfterMs: FLUSH_MS });
      // The ref tips and merges of each page are checked before it is shown (session.ts loadMore).
      const kept = page.commits.filter((c) => tips.has(c.hash) || c.parents.length > 1).map((c) => c.hash);
      const t = performance.now();
      await changingCommits('git', repo, kept, filter);
      tipCheckMs += performance.now() - t;
      rows += page.commits.length;
      if (firstRowMs < 0 && rows > 0) firstRowMs = performance.now() - started;
      if (page.done) return { firstRowMs, doneMs: performance.now() - started, rows, tipCheckMs };
    }
  } finally {
    r.dispose();
  }
}

async function measure(label: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const path of paths) {
    const all: Awaited<ReturnType<typeof readOnce>>[] = [];
    for (let i = 0; i <= runs; i++) {
      const m = await readOnce(path);
      if (i > 0) all.push(m); // run 0 warms the page cache
    }
    const pick = (k: 'firstRowMs' | 'doneMs' | 'tipCheckMs') => all.map((m) => Math.round(m[k]));
    out[path] = {
      rows: all[0]!.rows,
      firstRowMs: { median: median(pick('firstRowMs')), runs: pick('firstRowMs') },
      doneMs: { median: median(pick('doneMs')), runs: pick('doneMs') },
      tipCheckMs: median(pick('tipCheckMs')),
    };
  }
  return { label, paths: out };
}

const info = () => git('rev-parse', '--git-path', 'objects/info').trim();
function setCommitGraph(mode: 'none' | 'plain' | 'bloom'): number {
  execFileSync('rm', ['-rf', `${info()}/commit-graph`, `${info()}/commit-graphs`], { cwd: repo });
  const t = performance.now();
  if (mode !== 'none') git('commit-graph', 'write', '--reachable', ...(mode === 'bloom' ? ['--changed-paths'] : []));
  return Math.round(performance.now() - t);
}

const env = {
  git: git('--version').trim(),
  node: process.version,
  cpu: `${cpus().length} × ${cpus()[0]?.model ?? 'unknown'}`,
  commits: Number(git('rev-list', '--count', '--branches', '--remotes', 'HEAD').trim()),
  refs: git('for-each-ref', '--format=x').split('\n').filter(Boolean).length,
  runs,
};
setCommitGraph('none');
const none = await measure('without commit-graph');
const plainWriteMs = setCommitGraph('plain');
const plain = await measure('with commit-graph');
const bloomWriteMs = setCommitGraph('bloom');
const bloom = await measure('with commit-graph and changed-path filters');
console.log(
  JSON.stringify(
    { env, writeMs: { plain: plainWriteMs, bloom: bloomWriteMs }, results: [none, plain, bloom] },
    null,
    2,
  ),
);
