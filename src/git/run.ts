import { execFile } from 'node:child_process';
import { gitEnv } from './env.ts';

/** Runs git to completion and returns stdout. Rejects with stderr on non-zero exit. */
export function runGit(git: string, cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(git, args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20, env: gitEnv() }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}
