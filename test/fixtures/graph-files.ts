import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** Commits in one commit-graph file: the last entry of its OID fanout chunk. */
function commitsIn(file: string): number {
  const b = readFileSync(file);
  const chunks = b[6]!;
  for (let i = 0; i < chunks; i++) {
    const at = 8 + i * 12;
    if (b.toString('latin1', at, at + 4) === 'OIDF') return b.readUInt32BE(Number(b.readBigUInt64BE(at + 4)) + 255 * 4);
  }
  throw new Error(`${file}: no OID fanout chunk`);
}

/** Number of commits in the repository's commit-graph (all layers of a split graph), 0 without one. */
export function graphCommitCount(dir: string): number {
  const info = execFileSync('git', ['rev-parse', '--git-path', 'objects/info'], { cwd: dir, encoding: 'utf8' }).trim();
  const base = isAbsolute(info) ? info : join(dir, info);
  const chain = join(base, 'commit-graphs', 'commit-graph-chain');
  if (existsSync(chain)) {
    return readFileSync(chain, 'utf8')
      .split('\n')
      .filter(Boolean)
      .reduce((n, h) => n + commitsIn(join(base, 'commit-graphs', `graph-${h}.graph`)), 0);
  }
  const single = join(base, 'commit-graph');
  return existsSync(single) ? commitsIn(single) : 0;
}
