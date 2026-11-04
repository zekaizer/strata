import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RefSnapshot } from '../../src/core/refs.ts';
import { parseTarget, StaleTarget } from '../../src/host/target.ts';

const hash = 'a'.repeat(40);
const refs: RefSnapshot = {
  head: hash,
  headBranch: 'main',
  remotes: ['origin'],
  refs: [
    { name: 'refs/heads/main', short: 'main', kind: 'branch', hash },
    { name: 'refs/remotes/origin/main', short: 'origin/main', kind: 'remote', hash },
    { name: 'refs/tags/v1', short: 'v1', kind: 'tag', hash },
  ],
};
const menu = (ctx: Record<string, unknown>) => ({ webview: 'strata.graph', ...ctx });

describe('menu targets', () => {
  it('parses the element a menu was opened on into its target', () => {
    assert.deepEqual(
      parseTarget(menu({ webviewSection: 'commit', strataHash: hash, strataIsHead: true }), ['commit'], refs),
      {
        kind: 'commit',
        hash,
      },
    );
    assert.deepEqual(
      parseTarget(
        menu({ webviewSection: 'remoteBranch', strataRef: 'refs/remotes/origin/main', strataHash: hash }),
        ['branch', 'remoteBranch'],
        refs,
      ),
      { kind: 'remoteBranch', ref: refs.refs[1] },
    );
  });

  it('rejects contexts of other elements and malformed values', () => {
    assert.throws(() => parseTarget(menu({ webviewSection: 'tag', strataRef: 'refs/tags/v1' }), ['branch'], refs));
    assert.throws(() => parseTarget(menu({ webviewSection: 'commit', strataHash: '--all' }), ['commit'], refs));
    assert.throws(() => parseTarget(menu({ webviewSection: 'branch', strataRef: 'refs/tags/v1' }), ['branch'], refs));
    assert.throws(() => parseTarget(undefined, ['commit'], refs));
  });

  it('says a ref the graph no longer has is gone', () => {
    assert.throws(
      () => parseTarget(menu({ webviewSection: 'branch', strataRef: 'refs/heads/gone' }), ['branch'], refs),
      (e: unknown) =>
        e instanceof StaleTarget && e.message === "'gone' no longer exists; the graph has been refreshed.",
    );
  });
});
