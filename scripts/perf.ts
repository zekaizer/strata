// Measures first-page latency and layout cost on a real repository, with and
// without a commit-graph file. Usage: node scripts/perf.ts <repo> [runs]
// Prints a JSON summary; numbers are copied into docs/PERFORMANCE.md by hand.
import { execFileSync } from 'node:child_process';
import { cpus } from 'node:os';
import { initialLaneState, layoutPage, type LaneState } from '../src/core/layout.ts';
import { LogReader } from '../src/git/log-reader.ts';

const repo = process.argv[2] ?? '';
const runs = Number(process.argv[3] ?? 5);
if (repo === '') throw new Error('usage: node scripts/perf.ts <repo> [runs]');
const FIRST_PAGE = 300;
const LAYOUT_COMMITS = 100_000;

const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 30 });
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

async function time(fn: () => unknown): Promise<number> {
  const t = performance.now();
  await fn();
  return performance.now() - t;
}

async function measure(label: string): Promise<Record<string, unknown>> {
  const firstPage: number[] = [];
  for (let i = 0; i <= runs; i++) {
    const r = new LogReader({ git: 'git', cwd: repo });
    const ms = await time(() => r.next(FIRST_PAGE));
    r.dispose();
    if (i > 0) firstPage.push(ms); // run 0 warms the page cache
  }
  const order: Record<string, number> = {};
  for (const [name, flag] of [
    ['date-order', '--date-order'],
    ['topo-order', '--topo-order'],
    ['default', ''],
  ] as const) {
    const xs: number[] = [];
    for (let i = 0; i < 3; i++) {
      xs.push(
        await time(() =>
          git(
            'log',
            ...(flag ? [flag] : []),
            `-n${FIRST_PAGE}`,
            '--format=%H',
            '--branches',
            '--remotes',
            '--tags',
            'HEAD',
          ),
        ),
      );
    }
    order[name] = Math.round(median(xs));
  }
  return {
    label,
    firstPageMs: { median: Math.round(median(firstPage)), runs: firstPage.map(Math.round) },
    gitLogFirstPageMsByOrder: order,
  };
}

async function layoutCost(): Promise<Record<string, unknown>> {
  const r = new LogReader({ git: 'git', cwd: repo });
  const commits = (await r.next(LAYOUT_COMMITS)).commits;
  r.dispose();
  // As the extension lays out a view of all refs: column 0 held for HEAD.
  const head = git('rev-parse', 'HEAD').trim();
  let state: LaneState = initialLaneState(head);
  let maxWidth = 0;
  let spans = 0;
  const t = performance.now();
  for (let i = 0; i < commits.length; i += 1000) {
    const page = layoutPage(state, commits.slice(i, i + 1000));
    state = page.state;
    spans += page.spans.length;
    maxWidth = Math.max(
      maxWidth,
      state.lanes.length,
      ...page.rows.flatMap((r) => [r.lane + 1, ...r.outgoing.map((e) => e.lane + 1)]),
    );
  }
  const ms = performance.now() - t;
  const firstPage = await time(() => layoutPage(initialLaneState(head), commits.slice(0, FIRST_PAGE)));
  return {
    commits: commits.length,
    totalMs: Math.round(ms),
    usPerCommit: Number(((ms * 1000) / commits.length).toFixed(2)),
    firstPageMs: Number(firstPage.toFixed(2)),
    maxWidth,
    spans,
  };
}

const graphFiles = () => git('rev-parse', '--git-path', 'objects/info').trim();
function setCommitGraph(on: boolean): void {
  execFileSync('rm', ['-rf', `${graphFiles()}/commit-graph`, `${graphFiles()}/commit-graphs`], { cwd: repo });
  if (on) git('commit-graph', 'write', '--reachable');
}

const env = {
  git: git('--version').trim(),
  node: process.version,
  cpu: `${cpus().length} × ${cpus()[0]?.model ?? 'unknown'}`,
  commits: Number(git('rev-list', '--count', '--branches', '--remotes', '--tags', 'HEAD').trim()),
  refs: git('for-each-ref', '--format=x').split('\n').filter(Boolean).length,
};
setCommitGraph(false);
const without = await measure('without commit-graph');
const writeMs = await time(() => {
  setCommitGraph(true);
});
const withGraph = await measure('with commit-graph');
const layout = await layoutCost();
console.log(
  JSON.stringify({ env, commitGraphWriteMs: Math.round(writeMs), results: [without, withGraph], layout }, null, 2),
);
