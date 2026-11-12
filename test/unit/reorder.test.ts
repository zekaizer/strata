import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clashes, moveBlock, moved, rewrittenCount } from '../../src/core/reorder.ts';

const line = ['e', 'd', 'c', 'b', 'a'];

describe('a draft that reorders commits', () => {
  it('moves one commit to a gap above or below it', () => {
    assert.deepEqual(moveBlock(line, 2, 2, 0), ['c', 'e', 'd', 'b', 'a']);
    assert.deepEqual(moveBlock(line, 2, 2, 1), ['e', 'c', 'd', 'b', 'a']);
    assert.deepEqual(moveBlock(line, 2, 2, 4), ['e', 'd', 'b', 'c', 'a']);
    assert.deepEqual(moveBlock(line, 2, 2, 5), ['e', 'd', 'b', 'a', 'c']);
    assert.deepEqual(moveBlock(line, 0, 0, 5), ['d', 'c', 'b', 'a', 'e']);
  });

  it('moves a run of commits as a block', () => {
    assert.deepEqual(moveBlock(line, 1, 2, 0), ['d', 'c', 'e', 'b', 'a']);
    assert.deepEqual(moveBlock(line, 1, 2, 4), ['e', 'b', 'd', 'c', 'a']);
    assert.deepEqual(moveBlock(line, 3, 4, 1), ['e', 'b', 'a', 'd', 'c']);
  });

  it('moves nothing to a gap at or inside the block, or for a block that is not in the list', () => {
    for (const gap of [1, 2, 3]) assert.equal(moveBlock(line, 1, 2, gap), undefined, `gap ${gap}`);
    assert.equal(moveBlock(line, 0, 4, 0), undefined);
    assert.equal(moveBlock(line, 2, 1, 0), undefined);
    assert.equal(moveBlock(line, -1, 1, 4), undefined);
    assert.equal(moveBlock(line, 3, 5, 0), undefined);
    assert.equal(moveBlock(line, 1, 1, 6), undefined);
    assert.equal(moveBlock(line, 1, 1, -1), undefined);
    assert.equal(moveBlock(line, 1, 1, 0.5), undefined);
  });

  it('leaves the list it was given as it is', () => {
    const order = [...line];
    moveBlock(order, 0, 0, 3);
    assert.deepEqual(order, line);
  });

  it('counts the commits rewritten from the top down to the deepest one out of place', () => {
    assert.equal(rewrittenCount(line, line), 0);
    assert.equal(rewrittenCount(line, ['d', 'e', 'c', 'b', 'a']), 2);
    assert.equal(rewrittenCount(line, ['e', 'd', 'b', 'c', 'a']), 4);
    assert.equal(rewrittenCount(line, ['a', 'd', 'c', 'b', 'e']), 5);
    assert.equal(rewrittenCount(line, ['d', 'e']), 2, 'an order of the top of the line');
    assert.equal(rewrittenCount(line, ['e', 'd']), 0);
  });

  it('says how far each commit moved, leaving out those that kept their place', () => {
    assert.deepEqual([...moved(line, line)], []);
    assert.deepEqual(
      [...moved(line, ['b', 'e', 'd', 'c', 'a'])],
      [
        ['b', -3],
        ['e', 1],
        ['d', 1],
        ['c', 1],
      ],
    );
    assert.deepEqual(
      [...moved(line, ['a', 'd', 'c', 'b', 'e'])],
      [
        ['a', -4],
        ['e', 4],
      ],
    );
  });

  const files = new Map([
    ['e', ['src/a.ts', 'src/b.ts', 'README.md']],
    ['d', ['docs/x.md']],
    ['c', ['README.md', 'src/b.ts']],
    ['b', ['src/a.ts']],
    ['a', []],
  ]);

  it('finds no clash while every pair of commits that share a file keeps its order', () => {
    assert.deepEqual(clashes(line, line, files), []);
    assert.deepEqual(clashes(line, ['d', 'e', 'c', 'b', 'a'], files), [], 'd and e share no file');
    assert.deepEqual(clashes(line, ['e', 'c', 'd', 'a', 'b'], files), []);
  });

  it('names the pairs put the other way round that change a file in common', () => {
    assert.deepEqual(clashes(line, ['d', 'c', 'e', 'b', 'a'], files), [
      { newer: 'e', older: 'c', file: 'src/b.ts', files: 2 },
    ]);
    assert.deepEqual(clashes(line, ['b', 'c', 'd', 'e', 'a'], files), [
      { newer: 'e', older: 'b', file: 'src/a.ts', files: 1 },
      { newer: 'e', older: 'c', file: 'src/b.ts', files: 2 },
    ]);
  });

  it('takes a commit whose files are not known to change none', () => {
    assert.deepEqual(clashes(line, ['c', 'e', 'd', 'b', 'a'], new Map([['e', ['README.md']]])), []);
  });
});
