import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Unix domain socket paths (sun_path) are limited to 108 bytes including NUL. */
export const SUN_PATH_MAX = 107;

/**
 * user-data-dir for a test VS Code instance. VS Code creates its main IPC
 * socket inside it, so the path must stay short.
 */
export function userDataDir(label: string, base: string = process.env['STRATA_TEST_TMP'] ?? tmpdir()): string {
  return join(base, `st-${label}`);
}

/** Longest socket path VS Code creates under `dir` for a given version string. */
export function mainSocketPath(dir: string, version: string): string {
  return join(dir, `${version}-main.sock`);
}
