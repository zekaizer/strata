import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Commit } from '../core/commit.ts';
import { LOG_FORMAT, LogParser } from '../core/log-parser.ts';
import { parseRepoPath } from '../core/path-filter.ts';
import { isCommitId } from './details.ts';
import { gitEnv } from './env.ts';
import { runGit } from './run.ts';

/** Row order; both list children before their parents. */
export type CommitOrder = 'topological' | 'date';

export interface LogOptions {
  /** git executable. */
  git: string;
  /** Repository working directory. */
  cwd: string;
  /** Follow first parents only; commits then report at most one parent. */
  firstParent?: boolean;
  /** Full ref names (refs/...) to show history of; default: all branches, remote-tracking branches and HEAD. */
  refs?: string[] | undefined;
  /**
   * Repository-relative paths (a folder ends with '/'): only commits that change one of them, and
   * the tips of the refs shown and HEAD, which keep their badges. Parents are rewritten to the
   * nearest such ancestor, so every lane closes.
   */
  paths?: readonly string[] | undefined;
  /** Commit ids other worktrees have checked out, also shown when `refs` is undefined; missing ones are skipped. */
  heads?: readonly string[] | undefined;
  /**
   * 'topological' (default) keeps the commits of a line of history together; 'date' lists by commit
   * date, so a new commit moves no other row.
   */
  order?: CommitOrder | undefined;
}

/**
 * The revision arguments of the view `opts` describes, ending with `--` and its pathspecs: its
 * commits and their order. Every git command that lists or counts the graph's commits uses them,
 * so they agree with the graph's order. Rejects ref names that are not full names, paths outside
 * the repository and a missing `cwd`.
 */
export async function viewArgs(opts: LogOptions): Promise<string[]> {
  const { git, cwd, firstParent, refs, paths = [] } = opts;
  const heads = refs ? [] : (opts.heads ?? []);
  // Refs and paths come from the webview; only full ref names and paths may reach git, never options.
  const bad = refs?.find((r) => !/^refs\/[^\s]+$/.test(r) || r.includes('..'));
  if (bad !== undefined) throw new Error(`invalid ref name: ${bad}`);
  const badPath = paths.find((p) => parseRepoPath(p) === undefined);
  if (badPath !== undefined) throw new Error(`invalid path: ${badPath}`);
  const notId = heads.find((h) => !isCommitId(h));
  if (notId !== undefined) throw new Error(`invalid commit id: ${notId}`);
  // Otherwise spawn reports a missing cwd as "spawn git ENOENT", blaming git.
  if (!existsSync(cwd)) throw new Error(`repository folder not found: ${cwd}`);
  // HEAD is listed explicitly so a detached HEAD shows up, but only when it
  // resolves: on an unborn branch `git log HEAD` fails.
  const head = refs
    ? []
    : await runGit(git, cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).then(
        () => ['HEAD'],
        () => [],
      );
  return [
    // Topological order keeps each branch's commits together, which keeps the graph narrow.
    opts.order === 'date' ? '--date-order' : '--topo-order',
    ...(firstParent ? ['--first-parent'] : []),
    // --simplify-by-decoration implies --simplify-merges: git prints nothing until the walk is
    // done (see docs/PERFORMANCE.md), and keeps merges that join the lines of kept commits.
    ...(paths.length > 0
      ? [
          '--parents',
          '--simplify-by-decoration',
          // Branch tips and HEAD only: a row per tag would bury the commits that change the paths.
          // Other worktrees' detached HEADs are not decorations: kept only when they change the paths.
          ...(refs ?? ['refs/heads/', 'refs/remotes/']).map((r) => `--decorate-refs=${r}`),
          '--decorate-refs=HEAD',
        ]
      : []),
    // Tags are not start points: hundreds of old release tags make git's topological walk cover nearly
    // all history before the first commit is printed. Tags still label commits reachable from branches.
    ...(refs ?? ['--branches', '--remotes', ...head]),
    // A head gone since the worktree list was read is skipped, not an error.
    ...(heads.length > 0 ? ['--ignore-missing', ...heads] : []),
    '--',
    // A ':' or '*' in a file name is not pathspec magic; literal pathspecs still use Bloom filters.
    ...paths.map((p) => `:(literal)${p}`),
  ];
}

export interface PageOptions {
  /** After this long, a page holding at least one commit is returned with fewer than asked for. */
  flushAfterMs?: number;
}

export interface Page {
  /** As many as asked for, unless history ended or PageOptions.flushAfterMs passed. */
  commits: Commit[];
  /**
   * True when history is exhausted; later calls return no commits. A page that
   * ends exactly at the last commit may report false while git is still
   * finishing; the next call then returns an empty page with done = true.
   */
  done: boolean;
}

interface Request {
  count: number;
  /** The flush time passed: a partial page is served. */
  due: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  resolve: (p: Page) => void;
  reject: (e: Error) => void;
}

/**
 * Streams commit history from one `git log` process, a page at a time.
 * The process is paused (pipe backpressure) once one page beyond the
 * outstanding demand is buffered, so deep history is never read eagerly.
 */
export class LogReader {
  private readonly opts: LogOptions;
  private proc: ChildProcess | undefined;
  private starting: Promise<void> | undefined;
  private readonly parser = new LogParser();
  private buffer: Commit[] = [];
  private readonly queue: Request[] = [];
  private ended = false;
  private error: Error | undefined;
  private prefetch = 0;

  constructor(opts: LogOptions) {
    this.opts = opts;
  }

  next(count: number, opts: PageOptions = {}): Promise<Page> {
    if (!Number.isSafeInteger(count) || count < 0) return Promise.reject(new RangeError(`invalid page size ${count}`));
    if (this.error) return Promise.reject(this.error);
    this.prefetch = Math.max(this.prefetch, count);
    const flush = opts.flushAfterMs;
    const page = new Promise<Page>((resolve, reject) => {
      const req: Request = { count, due: false, timer: undefined, resolve, reject };
      if (flush !== undefined) {
        req.timer = setTimeout(() => {
          req.due = true;
          this.pump();
        }, flush);
      }
      this.queue.push(req);
    });
    this.starting ??= this.start().catch((e: unknown) => {
      this.fail(e instanceof Error ? e : new Error(String(e)));
    });
    this.pump();
    return page;
  }

  dispose(): void {
    this.fail(new Error('LogReader disposed'));
  }

  private async start(): Promise<void> {
    const { git, cwd, firstParent } = this.opts;
    const view = await viewArgs(this.opts);
    if (this.error) return;
    const args = [
      '-c',
      'log.showSignature=false',
      'log',
      // Output is decoded as UTF-8 whatever i18n.logOutputEncoding is configured to.
      '--encoding=UTF-8',
      '-z',
      `--format=${LOG_FORMAT}`,
      '--no-color',
      ...view,
    ];
    const proc = spawn(git, args, {
      cwd,
      env: gitEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;
    let stderr = '';
    proc.stderr.setEncoding('utf8').on('data', (d: string) => {
      if (stderr.length < 4096) stderr += d;
    });
    proc.stdout.setEncoding('utf8').on('data', (d: string) => {
      try {
        const commits = this.parser.push(d);
        // %P lists every parent even with --first-parent; the other parents never appear in this stream.
        if (firstParent)
          for (const c of commits)
            if (c.parents.length > 1) {
              c.otherParents = c.parents.slice(1);
              c.parents.length = 1;
            }
        this.buffer.push(...commits);
      } catch (e) {
        this.fail(e as Error);
        return;
      }
      this.pump();
    });
    proc.on('error', (e) => {
      this.fail(e);
    });
    proc.on('close', (code, signal) => {
      if (this.error) return;
      if (code !== 0) {
        // Hand out the complete pages already read before failing the rest.
        this.pump();
        this.fail(new Error(stderr.trim() || `git log ${signal ? `killed by ${signal}` : `exited with ${code}`}`));
        return;
      }
      try {
        this.parser.end();
      } catch (e) {
        this.fail(e as Error);
        return;
      }
      this.ended = true;
      this.pump();
    });
  }

  /** Serves queued requests in order and applies backpressure. */
  private pump(): void {
    while (this.queue.length > 0) {
      const req = this.queue[0]!;
      if (this.buffer.length < req.count && !this.ended && !(req.due && this.buffer.length > 0)) break;
      this.queue.shift();
      clearTimeout(req.timer);
      const commits = this.buffer.splice(0, req.count);
      req.resolve({ commits, done: this.ended && this.buffer.length === 0 });
    }
    const stdout = this.proc?.stdout;
    if (!stdout || this.ended) return;
    const demand = this.queue.reduce((n, r) => n + r.count, 0);
    if (this.buffer.length >= demand + this.prefetch) stdout.pause();
    else stdout.resume();
  }

  private fail(e: Error): void {
    if (this.error) return;
    this.error = e;
    this.proc?.kill();
    this.buffer = [];
    for (const r of this.queue.splice(0)) {
      clearTimeout(r.timer);
      r.reject(e);
    }
  }
}
