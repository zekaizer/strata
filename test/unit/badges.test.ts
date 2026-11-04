import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Ref, RefSnapshot } from '../../src/core/refs.ts';
import { landedRefs, MAX_BADGES, rowBadges } from '../../src/webview/badges.ts';

const h = (c: string) => c.repeat(40);
const at = h('c');
const ref = (name: string, upstream?: string): Ref => {
  const [, kind, short] = /^refs\/(heads|remotes|tags)\/(.*)$/.exec(name)!;
  return {
    name,
    short: short!,
    kind: kind === 'heads' ? 'branch' : kind === 'remotes' ? 'remote' : 'tag',
    hash: at,
    ...(upstream ? { upstream } : {}),
  };
};
const snapshot = (refs: Ref[], headBranch: string | undefined): RefSnapshot => ({
  head: at,
  headBranch,
  refs,
  remotes: ['origin', 'upstream', 'fork'],
});
const badgesOf = (refs: Ref[], headBranch: string | undefined = 'main') =>
  rowBadges(at, refs, snapshot(refs, headBranch));
const detached = (refs: Ref[]) => rowBadges(at, refs, snapshot(refs, undefined));

describe('rowBadges', () => {
  it("gives the current branch's badge the branch's own menu context", () => {
    const [main] = badgesOf([ref('refs/heads/main', 'refs/remotes/origin/main')]);
    assert.equal(main!.look, 'head');
    assert.deepEqual(main!.context, {
      webviewSection: 'branch',
      strataHash: at,
      strataRef: 'refs/heads/main',
      strataIsCurrent: true,
      strataUpstream: true,
    });
  });

  it('says a branch without an upstream has none, and is not current', () => {
    const [b] = badgesOf([ref('refs/heads/topic')]);
    assert.deepEqual(b!.context, {
      webviewSection: 'branch',
      strataHash: at,
      strataRef: 'refs/heads/topic',
      strataIsCurrent: false,
      strataUpstream: false,
    });
  });

  it('makes each remote name in a merged badge a target of its own, past two a "+k" for the rest', () => {
    const refs = ['refs/heads/x', 'refs/remotes/origin/x', 'refs/remotes/upstream/x', 'refs/remotes/fork/x'].map((n) =>
      ref(n),
    );
    const [x, ...others] = badgesOf(refs);
    assert.equal(others.length, 0, 'one merged badge');
    assert.deepEqual(
      x!.remotes.map((r) => [r.text, r.context]),
      [
        ['origin', { webviewSection: 'remoteBranch', strataHash: at, strataRef: 'refs/remotes/origin/x' }],
        ['upstream', { webviewSection: 'remoteBranch', strataHash: at, strataRef: 'refs/remotes/upstream/x' }],
        ['+1', { webviewSection: 'refs', strataHash: at, strataRefs: 'refs/remotes/fork/x' }],
      ],
    );
  });

  it('gives tags and remote-tracking branches of another name their own sections', () => {
    const sections = badgesOf([ref('refs/remotes/origin/develop'), ref('refs/tags/v1.0')]).map((b) => b.context);
    assert.deepEqual(sections, [
      { webviewSection: 'remoteBranch', strataHash: at, strataRef: 'refs/remotes/origin/develop' },
      { webviewSection: 'tag', strataHash: at, strataRef: 'refs/tags/v1.0' },
    ]);
  });

  it('puts a detached HEAD first, with only the commit', () => {
    const [head, tag] = detached([ref('refs/tags/v1.0')]);
    assert.deepEqual(head!.context, { webviewSection: 'head', strataHash: at });
    assert.equal(tag!.text, 'v1.0');
  });

  it('collapses badges past the limit into "+N", which stands for every ref it hides', () => {
    const tags = Array.from({ length: MAX_BADGES - 1 }, (_, i) => ref(`refs/tags/t${i}`));
    const refs = [...tags, ref('refs/heads/y'), ref('refs/remotes/origin/y'), ref('refs/tags/z')];
    const badges = badgesOf(refs);
    assert.equal(badges.length, MAX_BADGES);
    const more = badges.at(-1)!;
    assert.equal(more.text, '+2');
    assert.deepEqual(more.context, {
      webviewSection: 'refs',
      strataHash: at,
      strataRefs: 'refs/heads/y refs/remotes/origin/y refs/tags/z',
    });
    assert.deepEqual(
      badges.flatMap((b) => b.refs),
      refs.map((r) => r.name),
      'all refs of the row, collapsed ones included',
    );
  });
});

describe('landedRefs', () => {
  const b = (short: string, hash: string): Ref => ({ name: `refs/heads/${short}`, short, kind: 'branch', hash });
  const snap = (refs: Ref[], head: string, headBranch: string | undefined): RefSnapshot => ({
    head,
    headBranch,
    refs,
    remotes: [],
  });
  const main = b('main', h('1'));
  const topic = b('topic', h('2'));

  it('names the refs that moved or appeared', () => {
    const before = snap([main, topic], h('1'), 'main');
    const after = snap([{ ...main, hash: h('3') }, topic, b('new', h('2'))], h('3'), 'main');
    assert.deepEqual(landedRefs(before, after), ['refs/heads/main', 'refs/heads/new']);
  });

  it('names the branch HEAD switched to, though no ref moved', () => {
    assert.deepEqual(landedRefs(snap([main, topic], h('1'), 'main'), snap([main, topic], h('2'), 'topic')), [
      'refs/heads/topic',
    ]);
  });

  it('names HEAD when a detached HEAD moved, and nothing when nothing changed', () => {
    assert.deepEqual(landedRefs(snap([main], h('1'), undefined), snap([main], h('4'), undefined)), ['HEAD']);
    assert.deepEqual(landedRefs(snap([main], h('1'), 'main'), snap([main], h('1'), 'main')), []);
  });
});
