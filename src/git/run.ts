import { execFile } from 'node:child_process';
import { gitEnv } from './env.ts';

/** Runs git to completion and returns stdout. Rejects with stderr on non-zero exit. `env`: set on top of gitEnv(). */
export function runGit(git: string, cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const opts = { cwd, encoding: 'utf8', maxBuffer: 64 << 20, env: { ...gitEnv(), ...env } } as const;
    execFile(git, args, opts, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}
