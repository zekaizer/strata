import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canWrite, parseGitVersion } from '../../src/core/git-version.ts';

describe('git version', () => {
  it('reads the version of every platform build', () => {
    assert.deepEqual(parseGitVersion('git version 2.43.0\n'), [2, 43, 0]);
    assert.deepEqual(parseGitVersion('git version 2.39.3 (Apple Git-145)'), [2, 39, 3]);
    assert.deepEqual(parseGitVersion('git version 2.41.0.windows.1'), [2, 41, 0]);
    assert.deepEqual(parseGitVersion('git version 2.27'), [2, 27, 0]);
    assert.equal(parseGitVersion('not git'), undefined);
  });

  it('writes with git 2.27 and newer only', () => {
    assert.equal(canWrite([2, 27, 0]), true);
    assert.equal(canWrite([3, 0, 0]), true);
    assert.equal(canWrite([2, 26, 9]), false);
    assert.equal(canWrite([1, 99, 0]), false);
  });
});
