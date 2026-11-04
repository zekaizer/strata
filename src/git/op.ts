import { spawn } from 'node:child_process';
import { classifyGitError, parseProgress, type GitErrorKind } from '../core/git-error.ts';
import { gitEnv } from './env.ts';

/** A git command that changes the repository failed. */
export class GitOpError extends Error {
  readonly kind: GitErrorKind;
  readonly stderr: string;
  readonly stdout: string;
  constructor(kind: GitErrorKind, stdout: string, stderr: string) {
    super(stderr.trim() || 'git failed');
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
 * classified GitOpError; an abort kills git and rejects with an AbortError.
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
      proc.kill();
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new GitOpError(classifyGitError(stderr), stdout, stderr));
    });
  });
}

function abortError(): Error {
  const e = new Error('cancelled');
  e.name = 'AbortError';
  return e;
}
