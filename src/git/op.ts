import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { classifyGitError, parseProgress, type GitErrorKind } from '../core/git-error.ts';
import { argv, env, type Operation } from '../core/operations.ts';
import { gitEnv } from './env.ts';
import { runGit } from './run.ts';

/** A git command that changes the repository failed. */
export class GitOpError extends Error {
  readonly kind: GitErrorKind;
  readonly stderr: string;
  readonly stdout: string;
  constructor(kind: GitErrorKind, stdout: string, stderr: string) {
    super(stderr.trim() || stdout.trim() || 'git failed');
    this.kind = kind;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export interface OpOptions {
  signal?: AbortSignal;
  /** Called with each `--progress` update. */
  onProgress?: (p: { phase: string; percent: number }) => void;
  env?: Record<string, string>;
}

/**
 * Runs a git command that changes the repository and resolves with its output. Rejects with a
 * classified GitOpError; an abort kills git and rejects with an AbortError once it has exited.
 */
export function runGitOp(
  git: string,
  cwd: string,
  args: string[],
  opts: OpOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const { signal } = opts;
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const proc = spawn(git, args, {
      cwd,
      env: {
        ...gitEnv(),
        // classifyGitError reads git's English messages.
        LC_ALL: 'C',
        // Never wait for an editor nobody sees: keep the messages git prepared.
        GIT_EDITOR: 'true',
        GIT_SEQUENCE_EDITOR: 'true',
        GIT_MERGE_AUTOEDIT: 'no',
        ...opts.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // A new session has no controlling terminal: ssh then fails instead of waiting on /dev/tty for a
      // passphrase or a host key nobody sees. On Windows `detached` would open a console window.
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    proc.stderr.setEncoding('utf8').on('data', (d: string) => {
      stderr += d;
      const p = opts.onProgress && parseProgress(d);
      if (p) opts.onProgress?.(p);
    });
    const onAbort = () => {
      killGroup(proc);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    // After git and what it started closed their output: until then they may still hold locks.
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve({ stdout, stderr });
      else if (signal?.aborted) reject(abortError());
      else reject(new GitOpError(classify(stdout, stderr), stdout, stderr));
    });
  });
}

/** Runs `op` with its environment (env()) over `opts.env`; rejects like runGitOp. */
export async function runOperation(
  git: string,
  cwd: string,
  op: Operation,
  opts: OpOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await runGitOp(git, cwd, argv(op), { ...opts, env: { ...opts.env, ...env(op) } });
  } catch (e) {
    if (op.kind === 'merge' && op.autostash && e instanceof GitOpError)
      await applyLeftMergeAutostash(git, cwd, opts.env === undefined ? {} : { env: opts.env });
    throw e;
  }
}

/**
 * git 2.27 to 2.37 exit a `merge --autostash` that the merge strategy refuses (an untracked file in the
 * way) without applying the autostash: it stays in MERGE_AUTOSTASH with no merge in progress, for the
 * next merge to apply. Applies it as git 2.38 does: `stash apply`, else `stash store`.
 */
async function applyLeftMergeAutostash(git: string, cwd: string, opts: Pick<OpOptions, 'env'>) {
  const [file, head] = (
    await runGit(git, cwd, ['rev-parse', '--git-path', 'MERGE_AUTOSTASH', '--git-path', 'MERGE_HEAD'])
  )
    .split('\n')
    .map((p) => resolve(cwd, p));
  const stash = await readFile(file!, 'utf8').then(
    (s) => s.trim(),
    () => undefined,
  );
  const merging = await stat(head!).then(
    () => true,
    () => false,
  );
  if (stash === undefined || merging) return;
  await runGitOp(git, cwd, ['stash', 'apply', '--quiet', stash], opts).catch(() =>
    runGitOp(git, cwd, ['stash', 'store', '--quiet', '--message', 'autostash', stash], opts),
  );
  await rm(file!, { force: true });
}

/** Kills git and what it started (ssh, hooks): they share its process group. */
function killGroup(proc: ChildProcess): void {
  if (process.platform !== 'win32' && proc.pid !== undefined) {
    try {
      process.kill(-proc.pid, 'SIGTERM');
      return;
    } catch {
      // Already gone.
    }
  }
  proc.kill();
}

/** `merge` and `stash pop` print their conflicts on stdout only. */
function classify(stdout: string, stderr: string): GitErrorKind {
  const kind = classifyGitError(stderr);
  return kind === 'other' ? classifyGitError(stdout) : kind;
}

function abortError(): Error {
  const e = new Error('cancelled');
  e.name = 'AbortError';
  return e;
}
