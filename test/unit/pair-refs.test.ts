import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pairRefs, type Ref } from '../../src/core/refs.ts';

const H = 'a'.repeat(40);
const branch = (short: string): Ref => ({ kind: 'branch', short, name: `refs/heads/${short}`, hash: H });
const remote = (short: string): Ref => ({ kind: 'remote', short, name: `refs/remotes/${short}`, hash: H });
const tag = (short: string): Ref => ({ kind: 'tag', short, name: `refs/tags/${short}`, hash: H });
const show = (refs: Ref[], remotes: string[]) =>
  pairRefs(refs, remotes).map((b) => [b.ref.short, ...b.remotes.map((r) => r.short)].join(' + '));

describe('pairRefs', () => {
  it('merges a branch with its same-named remote-tracking branches', () => {
    assert.deepEqual(show([branch('main'), remote('origin/main'), remote('upstream/main')], ['origin', 'upstream']), [
      'main + origin/main + upstream/main',
    ]);
  });
  it('puts the merged badge where its earliest member was', () => {
    assert.deepEqual(show([tag('v1'), remote('origin/dev'), branch('dev')], ['origin']), ['v1', 'dev + origin/dev']);
  });
  it('keeps differently named upstreams and lone remotes separate', () => {
    assert.deepEqual(show([branch('main'), remote('origin/master'), remote('origin/x')], ['origin']), [
      'main',
      'origin/master',
      'origin/x',
    ]);
  });
  it('handles slashes in branch and remote names, longest remote first', () => {
    assert.deepEqual(show([branch('feature/a'), remote('origin/feature/a')], ['origin']), [
      'feature/a + origin/feature/a',
    ]);
    // refs/remotes/team/x/main belongs to remote "team/x", branch "main", not remote "team", branch "x/main".
    assert.deepEqual(show([branch('main'), branch('x/main'), remote('team/x/main')], ['team', 'team/x']), [
      'main + team/x/main',
      'x/main',
    ]);
  });
  it('does not merge tags, unknown remotes, or a local branch named like a remote ref', () => {
    assert.deepEqual(show([branch('v1'), tag('v1')], ['origin']), ['v1', 'v1']);
    assert.deepEqual(show([branch('main'), remote('gone/main')], ['origin']), ['main', 'gone/main']);
    assert.deepEqual(show([branch('origin/main'), remote('origin/main')], ['origin']), ['origin/main', 'origin/main']);
  });
  it('ignores remote HEAD refs', () => {
    assert.deepEqual(show([branch('HEAD'), remote('origin/HEAD')], ['origin']), ['HEAD', 'origin/HEAD']);
  });
});
