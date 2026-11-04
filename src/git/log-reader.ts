import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Commit } from '../core/commit.ts';
import { LOG_FORMAT, LogParser } from '../core/log-parser.ts';
import { gitEnv } from './env.ts';
import { runGit } from './run.ts';

export interface LogOptions {
  /** git executable. */
  git: string;
  /** Repository working directory. */
  cwd: string;
  /** Follow first parents only; commits then report at most one parent. */
  firstParent?: boolean;
  /** Full ref names (refs/...) to show history of; default: all branches, remote-tracking branches and HEAD. */
  refs?: string[] | undefined;
}

export interface Page {
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

  next(count: number): Promise<Page> {
    if (!Number.isSafeInteger(count) || count < 0) return Promise.reject(new RangeError(`invalid page size ${count}`));
    if (this.error) return Promise.reject(this.error);
    this.prefetch = Math.max(this.prefetch, count);
    const page = new Promise<Page>((resolve, reject) => {
      this.queue.push({ count, resolve, reject });
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
    const { git, cwd, firstParent, refs } = this.opts;
    // Refs come from the webview; only full ref names may reach git, never options.
    const bad = refs?.find((r) => !/^refs\/[^\s]+$/.test(r) || r.includes('..'));
    if (bad !== undefined) throw new Error(`invalid ref name: ${bad}`);
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
    if (this.error) return;
    const args = [
      '-c',
      'log.showSignature=false',
      'log',
      // Output is decoded as UTF-8 whatever i18n.logOutputEncoding is configured to.
      '--encoding=UTF-8',
      // Topological order keeps each branch's commits together, which keeps the graph narrow.
      '--topo-order',
      '-z',
      `--format=${LOG_FORMAT}`,
      '--no-color',
      ...(firstParent ? ['--first-parent'] : []),
      // Tags are not start points: hundreds of old release tags make git's topological walk cover nearly
      // all history before the first commit is printed. Tags still label commits reachable from branches.
      ...(refs ?? ['--branches', '--remotes', ...head]),
      '--',
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
        if (firstParent) for (const c of commits) c.parents.length = Math.min(c.parents.length, 1);
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
      if (this.buffer.length < req.count && !this.ended) break;
      this.queue.shift();
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
    for (const r of this.queue.splice(0)) r.reject(e);
  }
}
