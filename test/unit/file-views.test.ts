import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileViews } from '../../src/core/details.ts';

const BASE = 'a'.repeat(40);

describe('fileViews', () => {
  it('offers diff, before and after for modified and renamed files', () => {
    assert.deepEqual(fileViews({ status: 'M', path: 'a' }, BASE), ['diff', 'before', 'after']);
    assert.deepEqual(fileViews({ status: 'R', path: 'b', oldPath: 'a' }, BASE), ['diff', 'before', 'after']);
  });
  it('offers only the side that exists for added and deleted files', () => {
    assert.deepEqual(fileViews({ status: 'A', path: 'a' }, BASE), ['after']);
    assert.deepEqual(fileViews({ status: 'D', path: 'a' }, BASE), ['before']);
  });
  it('treats files of a root commit as added', () => {
    assert.deepEqual(fileViews({ status: 'M', path: 'a' }, undefined), ['after']);
  });
});
