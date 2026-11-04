import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { refNameProblem } from '../../src/core/ref-name.ts';

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
