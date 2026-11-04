import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { badgeOrder, type Ref } from '../../src/core/refs.ts';

const ref = (kind: Ref['kind'], short: string): Ref => ({
  kind,
  short,
  hash: 'a'.repeat(40),
  name:
    kind === 'branch'
      ? `refs/heads/${short}`
      : kind === 'remote'
        ? `refs/remotes/${short}`
        : kind === 'tag'
          ? `refs/tags/${short}`
          : 'refs/stash',
});
const names = (refs: Ref[]) => refs.map((r) => r.short);

const refs = [
  ref('tag', 'v1'),
  ref('remote', 'origin/main'),
  ref('branch', 'zeta'),
  ref('branch', 'alpha'),
  ref('tag', 'v0'),
];

describe('badgeOrder', () => {
  it('orders branches, remotes, tags, then by name', () => {
    assert.deepEqual(names(badgeOrder(refs, undefined, null)), ['alpha', 'zeta', 'origin/main', 'v0', 'v1']);
  });
  it('puts the current branch first', () => {
    assert.deepEqual(names(badgeOrder(refs, 'zeta', null)), ['zeta', 'alpha', 'origin/main', 'v0', 'v1']);
  });
  it('puts refs picked in the filter right after the current branch', () => {
    assert.deepEqual(names(badgeOrder(refs, 'zeta', ['refs/tags/v1', 'refs/remotes/origin/main'])), [
      'zeta',
      'origin/main',
      'v1',
      'alpha',
      'v0',
    ]);
  });
  it('keeps the current branch first when it is also picked', () => {
    assert.deepEqual(names(badgeOrder(refs, 'zeta', ['refs/heads/zeta', 'refs/tags/v0'])), [
      'zeta',
      'v0',
      'alpha',
      'origin/main',
      'v1',
    ]);
  });
  it('does not change its input', () => {
    const copy = [...refs];
    badgeOrder(refs, 'zeta', ['refs/tags/v1']);
    assert.deepEqual(refs, copy);
  });
});
