import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { canWrite, parseGitVersion, readOnly, readOnlyOf } from '../../src/core/git-version.ts';
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

  it('writes with git 2.34 and newer only', () => {
    assert.equal(canWrite([2, 34, 0]), true);
    assert.equal(canWrite([3, 0, 0]), true);
    assert.equal(canWrite([2, 33, 8]), false);
    assert.equal(canWrite([1, 99, 0]), false);
  });

  it('is read-only with a git too old to write, not with one whose version it cannot read', () => {
    assert.equal(readOnly([2, 33, 8]), true);
    assert.equal(readOnly([2, 34, 0]), false);
    assert.equal(readOnly(undefined), false);
  });

  it('names the git found when it is read-only, and nothing otherwise', () => {
    assert.deepEqual(readOnlyOf([2, 30, 1]), { gitVersion: '2.30.1' });
    assert.equal(readOnlyOf([2, 34, 0]), undefined);
    assert.equal(readOnlyOf(undefined), undefined);
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
