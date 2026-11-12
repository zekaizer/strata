export type GitVersion = readonly [major: number, minor: number, patch: number];

/** The oldest git CI tests (ADR 3). */
const WRITES_NEED: GitVersion = [2, 34, 0];

/** Parses `git version` output, e.g. "git version 2.39.3 (Apple Git-145)" or "git version 2.41.0.windows.1". */
export function parseGitVersion(out: string): GitVersion | undefined {
  const m = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(out.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined;
}

/** Whether `v` is `need` or newer. */
export function atLeast(v: GitVersion, need: GitVersion): boolean {
  for (let i = 0; i < 3; i++) if (v[i] !== need[i]) return v[i]! > need[i]!;
  return true;
}

/** Whether Strata's write operations run with this git. */
export const canWrite = (v: GitVersion): boolean => atLeast(v, WRITES_NEED);

/**
 * Whether write commands are off for the git whose version read gave `v`. Undefined (unparsable) is
 * not read-only: git itself judges.
 */
export const readOnly = (v: GitVersion | undefined): boolean => v !== undefined && !canWrite(v);

/** `git hook run`, which runs a hook as git's own commands do (core.hooksPath, Windows), is 2.36's. */
export const HOOK_RUN: GitVersion = [2, 36, 0];
