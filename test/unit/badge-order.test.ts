import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { badgeOrder, pairRefs, type Ref } from '../../src/core/refs.ts';

const ref = (kind: Ref['kind'], short: string): Ref => ({
  kind,
  short,
  hash: 'a'.repeat(40),
  name: kind === 'branch' ? `refs/heads/${short}` : kind === 'remote' ? `refs/remotes/${short}` : `refs/tags/${short}`,
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
    assert.deepEqual(names(badgeOrder(refs, undefined, undefined, null)), ['alpha', 'zeta', 'origin/main', 'v0', 'v1']);
  });
  it('puts the current branch first', () => {
    assert.deepEqual(names(badgeOrder(refs, 'zeta', undefined, null)), ['zeta', 'alpha', 'origin/main', 'v0', 'v1']);
  });
  it('puts refs picked in the filter right after the current branch', () => {
    assert.deepEqual(names(badgeOrder(refs, 'zeta', undefined, ['refs/tags/v1', 'refs/remotes/origin/main'])), [
      'zeta',
      'origin/main',
      'v1',
      'alpha',
      'v0',
    ]);
  });
  it('keeps the current branch first when it is also picked', () => {
    assert.deepEqual(names(badgeOrder(refs, 'zeta', undefined, ['refs/heads/zeta', 'refs/tags/v0'])), [
      'zeta',
      'v0',
      'alpha',
      'origin/main',
      'v1',
    ]);
  });
  it("puts the current branch's upstream right after the current branch, before picked refs", () => {
    const more = [...refs, ref('remote', 'origin/zeta-up'), ref('remote', 'origin/a')];
    assert.deepEqual(names(badgeOrder(more, 'zeta', 'refs/remotes/origin/zeta-up', ['refs/tags/v1'])), [
      'zeta',
      'origin/zeta-up',
      'v1',
      'alpha',
      'origin/a',
      'origin/main',
      'v0',
    ]);
  });
  it('puts the upstream first on a commit without the current branch', () => {
    assert.deepEqual(names(badgeOrder(refs, 'zeta-up', 'refs/remotes/origin/main', null).slice(0, 2)), [
      'origin/main',
      'alpha',
    ]);
  });
  it('leaves a same-named upstream merged into the current branch badge', () => {
    const main = { ...ref('branch', 'main'), upstream: 'refs/remotes/origin/main' };
    const local = [ref('tag', 'v0'), ref('remote', 'origin/main'), ref('branch', 'alpha'), main];
    const badges = pairRefs(badgeOrder(local, 'main', 'refs/remotes/origin/main', null), ['origin']);
    assert.deepEqual(
      badges.map((b) => [b.ref.short, ...b.remotes.map((r) => r.short)].join(' + ')),
      ['main + origin/main', 'alpha', 'v0'],
    );
  });
  it('does not change its input', () => {
    const copy = [...refs];
    badgeOrder(refs, 'zeta', undefined, ['refs/tags/v1']);
    assert.deepEqual(refs, copy);
  });
});
