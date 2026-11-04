import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 << 20 }).replace(/\n$/, '');

/**
 * A temp directory removed after the enclosing suite. Call it in a describe
 * body, not in a hook: `after` registered from a hook does not wait for the suite.
 */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `strata-${prefix}-`));
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
