import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  chain,
  cleanMessage,
  inPlace,
  planOf,
  refFates,
  todoText,
  type LineCommit,
  type RefTip,
  type RewritePlan,
} from '../../src/core/rewrite.ts';

const ident = (n: number) => ({ name: `A${n}`, email: `a${n}@e`, date: `${1700000000 + n} +0000` });

/** HEAD's line newest first: e (HEAD), d, c, b, a (root); `merges` lists commits given a second parent. */
function line(merges: string[] = []): LineCommit[] {
  const names = ['e', 'd', 'c', 'b', 'a'];
  return names.map((h, i) => ({
    hash: h,
    parents: [...(names[i + 1] ? [names[i + 1]!] : []), ...(merges.includes(h) ? ['side'] : [])],
    tree: `T${h}`,
    author: ident(i),
    message: `${h} subject\n`,
  }));
}

const plan = (p: RewritePlan | string): RewritePlan => {
  if (typeof p === 'string') assert.fail(`refused: ${p}`);
  return p;
};
const steps = (p: RewritePlan) => p.steps.map((s) => `${s.action} ${s.commit}`).join(', ');

describe('rewrite plans', () => {
  it('rewords a commit, replaying the newer ones on top', () => {
    const p = plan(planOf({ kind: 'reword', commit: 'c', message: 'new\n\n\nbody  \n\n' }, line()));
    assert.equal(p.base, 'b');
    assert.equal(steps(p), 'reword c, pick d, pick e');
    assert.deepEqual(p.steps[0], { action: 'reword', commit: 'c', message: 'new\n\nbody\n' });
    assert.equal(inPlace(p, line()), true);
  });

  it('squashes a run into its oldest commit, the message on the newest', () => {
    const p = plan(planOf({ kind: 'squash', oldest: 'b', newest: 'd', message: 'all\n' }, line()));
    assert.equal(steps(p), 'pick b, fixup c, fixup d, pick e');
    assert.deepEqual(p.steps[2], { action: 'fixup', commit: 'd', message: 'all\n' });
    assert.equal(inPlace(p, line()), true);
    assert.equal(
      steps(plan(planOf({ kind: 'squash', oldest: 'c', newest: 'c', message: 'x' }, line()))),
      'reword c, pick d, pick e',
    );
  });

  it('moves a fixup next to its target, in place only when it is already there', () => {
    const near = plan(planOf({ kind: 'fixup', commit: 'd', into: 'c' }, line()));
    assert.equal(steps(near), 'pick c, fixup d, pick e');
    assert.equal(inPlace(near, line()), true);
    const far = plan(planOf({ kind: 'fixup', commit: 'e', into: 'b' }, line()));
    assert.equal(steps(far), 'pick b, fixup e, pick c, pick d');
    assert.equal(far.base, 'a');
    assert.equal(inPlace(far, line()), false);
  });

  it('drops a run, through a rebase', () => {
    const p = plan(planOf({ kind: 'drop', oldest: 'c', newest: 'd' }, line()));
    assert.equal(steps(p), 'drop c, drop d, pick e');
    assert.equal(inPlace(p, line()), false);
    assert.equal(todoText(p), 'drop c\ndrop d\npick e\n');
    const all = plan(planOf({ kind: 'drop', oldest: 'b', newest: 'e' }, line()));
    assert.equal(todoText(all), 'drop b\ndrop c\ndrop d\ndrop e\nnoop\n');
    const root = plan(planOf({ kind: 'drop', oldest: 'a', newest: 'a' }, line()));
    assert.equal(root.base, undefined);
  });

  it('refuses what it cannot carry out', () => {
    assert.equal(planOf({ kind: 'reword', commit: 'x', message: 'm' }, line()), 'notOnHeadLine');
    assert.equal(planOf({ kind: 'reword', commit: 'b', message: 'm' }, line(['d'])), 'merge');
    assert.equal(planOf({ kind: 'reword', commit: 'b', message: 'm' }, line(['b'])), 'merge');
    assert.equal(typeof planOf({ kind: 'reword', commit: 'e', message: 'm' }, line(['c'])), 'object');
    assert.equal(planOf({ kind: 'squash', oldest: 'd', newest: 'b', message: 'm' }, line()), 'order');
    assert.equal(planOf({ kind: 'fixup', commit: 'b', into: 'd' }, line()), 'order');
    assert.equal(planOf({ kind: 'fixup', commit: 'b', into: 'b' }, line()), 'order');
    assert.equal(planOf({ kind: 'reword', commit: 'c', message: ' \n\n ' }, line()), 'emptyMessage');
    assert.equal(planOf({ kind: 'drop', oldest: 'a', newest: 'e' }, line()), 'nothingLeft');
  });

  it('chains new commits: parents by index, the first author, the last tree', () => {
    const p = plan(planOf({ kind: 'squash', oldest: 'b', newest: 'c', message: 'bc\n' }, line()));
    assert.deepEqual(chain(p, line()), [
      { tree: 'Tc', parent: 'base', author: ident(3), message: 'bc\n', replaces: ['b', 'c'], last: 'c', edited: true },
      { tree: 'Td', parent: 0, author: ident(1), message: 'd subject\n', replaces: ['d'], last: 'd', edited: false },
      { tree: 'Te', parent: 1, author: ident(0), message: 'e subject\n', replaces: ['e'], last: 'e', edited: false },
    ]);
    const fixup = plan(planOf({ kind: 'fixup', commit: 'e', into: 'd' }, line()));
    assert.deepEqual(
      chain(fixup, line()).map((c) => [c.tree, c.message, c.replaces.join(''), c.edited]),
      [['Te', 'd subject\n', 'de', false]],
      'a fixup keeps the message of the commit it melds into',
    );
    const root = plan(planOf({ kind: 'reword', commit: 'a', message: 'root' }, line()));
    assert.equal(root.base, undefined);
    assert.equal(chain(root, line())[0]!.parent, 'base');
    assert.throws(() => chain(plan(planOf({ kind: 'drop', oldest: 'c', newest: 'c' }, line())), line()));
    assert.throws(() => todoText(p), 'a message is never handed to a rebase');
  });

  it('cleans up a message as git does with whitespace cleanup', () => {
    assert.equal(
      cleanMessage('\n\n  subject  \r\n\r\n\r\n# Heading\n\tbody\t\n\n'),
      '  subject\n\n# Heading\n\tbody\n',
    );
    assert.equal(cleanMessage(' \n \n'), '');
  });

  it('moves a branch with its commit only where a new commit has the same content', () => {
    const tip = (short: string, hash: string, kind: RefTip['kind'] = 'branch', elsewhere = false): RefTip => ({
      name: `refs/${kind === 'tag' ? 'tags' : 'heads'}/${short}`,
      short,
      kind,
      hash,
      elsewhere,
    });
    const p = plan(planOf({ kind: 'squash', oldest: 'b', newest: 'c', message: 'bc' }, line()));
    const made = chain(p, line());
    const rewritten = new Set(['b', 'c', 'd', 'e']);
    const refs = [
      tip('at-c', 'c'),
      tip('at-b', 'b'),
      tip('v1', 'd', 'tag'),
      tip('used', 'e', 'branch', true),
      tip('off', 'x'),
    ];
    const fates = refFates(refs, rewritten, made);
    assert.deepEqual(
      fates.moves.map((m) => [m.ref.short, m.to]),
      [['at-c', 0]],
    );
    assert.deepEqual(
      fates.stays.map((s) => [s.ref.short, s.why]),
      [
        ['at-b', 'old'],
        ['v1', 'tag'],
        ['used', 'worktree'],
        ['off', 'forked'],
      ],
    );
    assert.deepEqual(
      refFates([tip('at-c', 'c')], rewritten, undefined).stays.map((s) => s.why),
      ['old'],
      'a rebase gives no exact counterpart',
    );
  });
});
