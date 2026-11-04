import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mainSocketPath, SUN_PATH_MAX, userDataDir } from '../../scripts/lib/test-paths.ts';

describe('test user-data-dir', () => {
  it('keeps the VS Code main IPC socket path within sun_path', () => {
    for (const label of ['stable', 'min']) {
      const sock = mainSocketPath(userDataDir(label), '1.144.1');
      assert.ok(Buffer.byteLength(sock) <= SUN_PATH_MAX, `${sock} is too long`);
    }
  });
});
