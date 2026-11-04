import { execFile } from 'node:child_process';

/** Runs git to completion and returns stdout. Rejects with stderr on non-zero exit. */
export function runGit(git: string, cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      git,
      args,
      { cwd, encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message));
        else resolve(stdout);
      },
    );
  });
}
