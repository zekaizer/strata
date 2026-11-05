import { execFile } from 'node:child_process';
import { gitEnv } from './env.ts';

/**
 * Stops git after `timeoutMs`, or when `signal` aborts; either way runGit rejects. Output git
 * finishes later than `timeoutMs` is rejected too: the kill can lose the race with git's exit.
 */
export interface GitLimits {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Runs git to completion and returns stdout. Rejects with stderr on non-zero exit. `env`: set on top of gitEnv(). */
export function runGit(
  git: string,
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  limits: GitLimits = {},
): Promise<string> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const opts = {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 << 20,
      env: { ...gitEnv(), ...env },
      timeout: limits.timeoutMs ?? 0,
      ...(limits.signal ? { signal: limits.signal } : {}),
    } as const;
    execFile(git, args, opts, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else if (limits.timeoutMs !== undefined && performance.now() - started > limits.timeoutMs)
        reject(new Error(`git took longer than ${limits.timeoutMs} ms`));
      else resolve(stdout);
    });
  });
}
