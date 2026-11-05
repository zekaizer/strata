import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { canWrite, parseGitVersion } from '../../src/core/git-version.ts';
import { readGitVersion } from '../../src/git/facts.ts';
import { tempDir } from './helpers.ts';

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

describe('the git version read', () => {
  const dir = tempDir('git-version');
  const fake = join(dir, 'git');
  const script = (version: string) => {
    writeFileSync(fake, `#!/bin/sh\necho 'git version ${version}'\n`, { mode: 0o755 });
  };

  it('reads again after a failure, and per git path', async () => {
    await assert.rejects(readGitVersion(fake, dir));
    script('2.30.1');
    assert.deepEqual(await readGitVersion(fake, dir), [2, 30, 1]);
    assert.deepEqual(
      await readGitVersion('git', dir),
      parseGitVersion(execFileSync('git', ['version'], { encoding: 'utf8' })),
    );
  });
});
