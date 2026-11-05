export type GitVersion = readonly [major: number, minor: number, patch: number];

/** The oldest git CI tests (ADR 3). */
const WRITES_NEED: GitVersion = [2, 34, 0];

/** Parses `git version` output, e.g. "git version 2.39.3 (Apple Git-145)" or "git version 2.41.0.windows.1". */
export function parseGitVersion(out: string): GitVersion | undefined {
  const m = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(out.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined;
}

/** Whether Strata's write operations run with this git. */
export function canWrite(v: GitVersion): boolean {
  for (let i = 0; i < 3; i++) if (v[i] !== WRITES_NEED[i]) return v[i]! > WRITES_NEED[i]!;
  return true;
}
