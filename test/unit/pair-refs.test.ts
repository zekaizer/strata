import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pairRefs, type Ref } from '../../src/core/refs.ts';

const H = 'a'.repeat(40);
/** A local branch; `upstream`: the short name of the remote-tracking branch it tracks. */
const branch = (short: string, upstream?: string): Ref => ({
  kind: 'branch',
  short,
  name: `refs/heads/${short}`,
  hash: H,
  ...(upstream ? { upstream: `refs/remotes/${upstream}`, tracks: true } : {}),
});
const remote = (short: string): Ref => ({ kind: 'remote', short, name: `refs/remotes/${short}`, hash: H });
const tag = (short: string): Ref => ({ kind: 'tag', short, name: `refs/tags/${short}`, hash: H });
const show = (refs: Ref[], remotes: string[]) =>
  pairRefs(refs, remotes).map((b) => [b.ref.short, ...(b.remote ? [b.remote.short] : [])].join(' + '));

describe('pairRefs', () => {
  it('merges a branch with its same-named upstream only', () => {
    assert.deepEqual(
      show([branch('main', 'upstream/main'), remote('origin/main'), remote('upstream/main')], ['origin', 'upstream']),
      ['main + upstream/main', 'origin/main'],
    );
  });
  it('merges nothing into a branch without an upstream', () => {
    assert.deepEqual(show([branch('main'), remote('origin/main')], ['origin']), ['main', 'origin/main']);
  });
  it('puts the merged badge where its earliest member was', () => {
    assert.deepEqual(show([tag('v1'), remote('origin/dev'), branch('dev', 'origin/dev')], ['origin']), [
      'v1',
      'dev + origin/dev',
    ]);
  });
  it('keeps differently named upstreams and lone remotes separate', () => {
    assert.deepEqual(show([branch('main', 'origin/master'), remote('origin/master'), remote('origin/x')], ['origin']), [
      'main',
      'origin/master',
      'origin/x',
    ]);
  });
  it('merges an upstream into the same-named one of the branches tracking it', () => {
    assert.deepEqual(
      show([branch('main', 'origin/main'), branch('mirror', 'origin/main'), remote('origin/main')], ['origin']),
      ['main + origin/main', 'mirror'],
    );
  });
  it('handles slashes in branch and remote names, longest remote first', () => {
    assert.deepEqual(show([branch('feature/a', 'origin/feature/a'), remote('origin/feature/a')], ['origin']), [
      'feature/a + origin/feature/a',
    ]);
    // refs/remotes/team/x/main belongs to remote "team/x", branch "main", not remote "team", branch "x/main".
    assert.deepEqual(
      show([branch('main', 'team/x/main'), branch('x/main', 'team/x/main'), remote('team/x/main')], ['team', 'team/x']),
      ['main + team/x/main', 'x/main'],
    );
  });
  it('does not merge tags, unknown remotes, or a local branch named like a remote ref', () => {
    assert.deepEqual(show([branch('v1'), tag('v1')], ['origin']), ['v1', 'v1']);
    assert.deepEqual(show([branch('main', 'gone/main'), remote('gone/main')], ['origin']), ['main', 'gone/main']);
    assert.deepEqual(show([branch('origin/main'), remote('origin/main')], ['origin']), ['origin/main', 'origin/main']);
  });
  it('ignores remote HEAD refs', () => {
    assert.deepEqual(show([branch('HEAD'), remote('origin/HEAD')], ['origin']), ['HEAD', 'origin/HEAD']);
  });
});
