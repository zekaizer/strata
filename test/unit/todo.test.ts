import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { messageEdits, sequencerTodo } from '../../src/core/todo.ts';

const h = (c: string) => c.repeat(40);

describe('the steps of a rebase that edit commit messages', () => {
  it('names reword, squash, fixup -c and merge without -C left in the todo list', () => {
    const todo = [
      `pick ${h('a')} # A`,
      `r ${h('b')} # B`,
      `edit ${h('c')} # C`,
      `s ${h('d')} # D`,
      `fixup ${h('e')} # E`,
      `fixup -C ${h('f')} # F`,
      `fixup -c ${h('1')} # G`,
      `exec make`,
      `merge -C ${h('2')} side # Merge side`,
      `merge -c ${h('3')} other # Merge other`,
      `merge third`,
      '# reword in a comment',
    ].join('\n');
    assert.deepEqual(messageEdits('', todo), [
      'reword bbbbbbb',
      'squash ddddddd',
      'fixup -c 1111111',
      'merge other',
      'merge third',
    ]);
  });

  it('names the stopped step, with the squash its fixup chain ends, but not the steps before', () => {
    const done = [`reword ${h('a')} # A`, `pick ${h('b')} # B`, `squash ${h('c')} # C`, `fixup ${h('d')} # D`].join(
      '\n',
    );
    assert.deepEqual(messageEdits(done, ''), ['squash ccccccc']);
    assert.deepEqual(messageEdits(`reword ${h('a')} # A\nedit ${h('b')} # B`, `pick ${h('c')} # C`), []);
    assert.deepEqual(messageEdits(`pick ${h('a')} # A\nreword ${h('b')} # B`, ''), ['reword bbbbbbb']);
  });
});

describe('a cherry pick or revert stopped between commits', () => {
  it('reads its kind and how many commits are left after the stopped one', () => {
    assert.deepEqual(sequencerTodo(`pick ${h('a')} A\npick ${h('b')} B\npick ${h('c')} C\n`), {
      kind: 'cherryPick',
      remaining: 2,
    });
    assert.deepEqual(sequencerTodo(`revert ${h('a')} A\n`), { kind: 'revert', remaining: 0 });
    assert.equal(sequencerTodo(''), undefined);
  });
});
