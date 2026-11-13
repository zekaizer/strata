import { execFile, spawn } from 'node:child_process';
import type { FindHit, FindQuery } from '../core/find.ts';
import { gitEnv } from './env.ts';
import { viewArgs, type LogOptions } from './log-reader.ts';
import { runGit } from './run.ts';

/** Hits gathered before a batch is handed out, and the longest a found hit waits for its batch. */
const BATCH_HITS = 200;
const BATCH_MS = 50;
/** Commits of an ambiguous hash prefix that are listed. */
const MAX_EXACT = 10;

export interface FindBatch {
  /** In graph order, after the hits of the batches before. */
  hits: FindHit[];
  done: boolean;
  /** More than `cap` commits match; only the first `cap` were handed out. */
  capped: boolean;
}

/**
 * Streams the commits of the view `opts` whose message contains `query.text` and whose author
 * contains `query.author` (both ignoring case), in the graph's order, in batches. Stops after
 * `cap` hits. Rejects when git fails, and when `signal` aborts (no further batch then).
 */
export async function findCommits(
  opts: LogOptions & { query: FindQuery; cap: number; signal: AbortSignal },
  onBatch: (batch: FindBatch) => void,
): Promise<void> {
  const { query, cap, signal } = opts;
  const view = await viewArgs(opts);
  signal.throwIfAborted();
  // User text only ever fills these two arguments, so git cannot read it as an option.
  const filters = [
    ...(query.text === '' ? [] : [`--grep=${query.text}`]),
    ...(query.author === undefined ? [] : [`--author=${query.author}`]),
  ];
  const args = [
    '-c',
    'log.showSignature=false',
    'log',
    '--encoding=UTF-8',
    '-z',
    '--format=%H%x00%s%x00%aN%x00%at%x00%P',
    '--no-color',
    '-i',
    '-F',
    ...filters,
    // One more than the cap tells a capped search from one with exactly `cap` hits.
    `--max-count=${cap + 1}`,
    ...view,
  ];
  let pending: FindHit[] = [];
  let found = 0;
  let capped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = (done: boolean) => {
    clearTimeout(timer);
    timer = undefined;
    if (signal.aborted) return;
    const hits = pending;
    pending = [];
    onBatch({ hits, done, capped });
  };
  let fields: string[] = [];
  let rest = '';
  try {
    await streamGit(opts.git, opts.cwd, args, signal, (chunk, stop) => {
      const parts = (rest + chunk).split('\0');
      rest = parts.pop()!;
      for (const part of parts) {
        fields.push(part);
        if (fields.length < 5) continue;
        const [hash, subject, author, time, parents] = fields as [string, string, string, string, string];
        fields = [];
        if (found === cap) {
          capped = true;
          stop();
          return;
        }
        found++;
        pending.push({ hash, subject, author, authorTime: Number(time), merge: parents.includes(' ') });
      }
      if (pending.length >= BATCH_HITS) flush(false);
      else if (pending.length > 0)
        timer ??= setTimeout(() => {
          flush(false);
        }, BATCH_MS);
    });
  } finally {
    clearTimeout(timer);
  }
  flush(true);
}

/** The commits whose full hash starts with `prefix` (4-40 lowercase hex digits), at most MAX_EXACT. */
export async function findExact(git: string, cwd: string, prefix: string): Promise<FindHit[]> {
  if (!/^[0-9a-f]{4,40}$/.test(prefix)) throw new Error('invalid hash prefix');
  const objects = await runGit(git, cwd, ['rev-parse', `--disambiguate=${prefix}`]);
  if (objects.trim() === '') return [];
  const types = await objectTypes(git, cwd, objects);
  const commits = types
    .split('\n')
    .filter((l) => l.startsWith('commit '))
    .map((l) => l.slice('commit '.length))
    .slice(0, MAX_EXACT);
  if (commits.length === 0) return [];
  const out = await runGit(git, cwd, [
    '-c',
    'log.showSignature=false',
    'log',
    '--encoding=UTF-8',
    '--no-walk=unsorted',
    '-z',
    '--format=%H%x00%s%x00%aN%x00%at%x00%P',
    ...commits,
    '--',
  ]);
  const f = out.split('\0');
  const hits: FindHit[] = [];
  for (let i = 0; i + 4 < f.length; i += 5)
    hits.push({
      hash: f[i]!,
      subject: f[i + 1]!,
      author: f[i + 2]!,
      authorTime: Number(f[i + 3]),
      merge: f[i + 4]!.includes(' '),
    });
  return hits;
}

export interface Located {
  /** Index of the commit in the view's order; undefined when the view does not have it. */
  position: number | undefined;
  /** When the view does not have it: the full names of the refs that reach it, tags first. */
  reachedBy: string[];
}

/** Where commit `hash` is in the view `opts`; rejects when git fails or `signal` aborts. */
export async function locateCommit(opts: LogOptions & { hash: string; signal: AbortSignal }): Promise<Located> {
  const { git, cwd, hash, signal } = opts;
  if (!/^[0-9a-f]{40}$/.test(hash)) throw new Error('invalid commit id');
  const view = await viewArgs(opts);
  signal.throwIfAborted();
  let position: number | undefined;
  let seen = 0;
  let rest = '';
  await streamGit(git, cwd, ['log', '--format=%H', ...view], signal, (chunk, stop) => {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop()!;
    const i = lines.indexOf(hash);
    if (i >= 0) {
      position = seen + i;
      stop();
    }
    seen += lines.length;
  });
  signal.throwIfAborted();
  if (position !== undefined) return { position, reachedBy: [] };
  const refs = await runGit(
    git,
    cwd,
    ['for-each-ref', `--contains=${hash}`, '--format=%(refname)', 'refs/tags', 'refs/heads', 'refs/remotes'],
    {},
    { signal },
  );
  return { position: undefined, reachedBy: refs.split('\n').filter((r) => r !== '') };
}

/**
 * Runs git and hands its stdout to `onData` as it arrives; `stop` there ends git early, which
 * counts as success. Rejects with git's stderr when it fails, and when `signal` aborts.
 */
function streamGit(
  git: string,
  cwd: string,
  args: string[],
  signal: AbortSignal,
  onData: (chunk: string, stop: () => void) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(git, args, { cwd, env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stopped = false;
    const stop = () => {
      stopped = true;
      proc.kill();
    };
    let stderr = '';
    proc.stderr.setEncoding('utf8').on('data', (d: string) => {
      if (stderr.length < 4096) stderr += d;
    });
    proc.stdout.setEncoding('utf8').on('data', (d: string) => {
      if (!stopped && !signal.aborted) onData(d, stop);
    });
    proc.on('error', reject);
    proc.on('close', (code, sig) => {
      if (signal.aborted) reject(signal.reason instanceof Error ? signal.reason : new Error('stopped'));
      else if (stopped || code === 0) resolve();
      else reject(new Error(stderr.trim() || `git ${args[0]} ${sig ? `killed by ${sig}` : `exited with ${code}`}`));
    });
  });
}

/** `git cat-file --batch-check` of the object names in `names` (one per line): "<type> <name>" lines. */
function objectTypes(git: string, cwd: string, names: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      git,
      ['cat-file', '--batch-check=%(objecttype) %(objectname)'],
      { cwd, env: gitEnv(), encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message));
        else resolve(stdout);
      },
    );
    proc.stdin?.end(names);
  });
}
