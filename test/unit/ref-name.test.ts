import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { pathConflict, refNameProblem } from '../../src/core/ref-name.ts';
import { git, tempDir } from './helpers.ts';

const NAMES = [
  'main',
  'feature/login',
  'fix-123_a.b',
  'ünïcode',
  'a/b/c',
  '',
  '-starts-with-dash',
  'has space',
  'tab\there',
  'a..b',
  '.hidden',
  'dir/.hidden',
  'ends.',
  'ends.lock',
  'dir/x.lock/y',
  'a//b',
  '/leading',
  'trailing/',
  'tilde~1',
  'caret^',
  'colon:x',
  'question?',
  'star*',
  'bracket[',
  'back\\slash',
  'at@{brace',
  '@',
  'a@b',
  'ctrl\u0001',
  'del\u007f',
  'HEAD',
];

describe('refNameProblem', () => {
  it('accepts exactly the names git branch and git tag accept', () => {
    for (const name of NAMES) {
      // git branch and git tag also refuse a leading '-' (an option); git branch refuses HEAD.
      const git =
        spawnSync('git', ['check-ref-format', `refs/heads/${name}`]).status === 0 &&
        !name.startsWith('-') &&
        name !== 'HEAD';
      assert.equal(
        refNameProblem(name) === undefined,
        git,
        `${JSON.stringify(name)}: git says ${git ? 'valid' : 'invalid'}`,
      );
    }
  });

  it('says what is wrong', () => {
    assert.equal(refNameProblem(''), 'Enter a name.');
    assert.equal(refNameProblem('a b'), "Names can't contain spaces.");
    assert.equal(refNameProblem('a..b'), "Names can't contain '..'.");
    assert.equal(refNameProblem('-x'), "Names can't start with '-'.");
  });
});

describe('pathConflict', () => {
  const dir = tempDir('ref-name');
  git(dir, 'init', '--quiet', '-b', 'main');
  git(dir, '-c', 'user.name=a', '-c', 'user.email=a@e', 'commit', '--quiet', '--allow-empty', '-m', 'one');
  const existing = ['main', 'feature', 'wip/a/b'];
  for (const b of existing.slice(1)) git(dir, 'branch', b);

  it('names the branch that keeps git from creating one, exactly when git refuses', () => {
    const expected: Record<string, string | undefined> = {
      'feature/x': 'feature',
      'feature/x/y': 'feature',
      'main/x': 'main',
      wip: 'wip/a/b',
      'wip/a': 'wip/a/b',
      'wip/a/b/c': 'wip/a/b',
      'wip/b': undefined,
      featurex: undefined,
      feat: undefined,
      'mai/n': undefined,
    };
    for (const [name, other] of Object.entries(expected)) {
      const refused = spawnSync('git', ['branch', name], { cwd: dir }).status !== 0;
      if (!refused) git(dir, 'branch', '--delete', name);
      assert.equal(refused, other !== undefined, `git ${refused ? 'refuses' : 'accepts'} ${name}`);
      assert.equal(pathConflict(name, existing), other, name);
    }
  });
});
