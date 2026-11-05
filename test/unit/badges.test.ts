import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Ref, RefSnapshot } from '../../src/core/refs.ts';
import { fitBadges, landedRefs, refsLabel, rowBadges } from '../../src/webview/badges.ts';

const h = (c: string) => c.repeat(40);
const at = h('c');
const ref = (name: string, upstream?: string, tracks = upstream !== undefined): Ref => {
  const [, kind, short] = /^refs\/(heads|remotes|tags)\/(.*)$/.exec(name)!;
  return {
    name,
    short: short!,
    kind: kind === 'heads' ? 'branch' : kind === 'remotes' ? 'remote' : 'tag',
    hash: at,
    ...(upstream ? { upstream } : {}),
    ...(tracks ? { tracks: true } : {}),
  };
};
const snapshot = (refs: Ref[], headBranch: string | undefined): RefSnapshot => ({
  head: at,
  headBranch,
  refs,
  remotes: ['origin', 'upstream', 'fork'],
});
const all = (badges: readonly unknown[]) => badges.length;
const badgesOf = (refs: Ref[], headBranch: string | undefined = 'main', keep = all) =>
  rowBadges(at, refs, snapshot(refs, headBranch), keep);
const detached = (refs: Ref[]) => rowBadges(at, refs, snapshot(refs, undefined), all);

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

  it('says a branch has an upstream when one is configured without a remote-tracking branch for it', () => {
    const [b] = badgesOf([ref('refs/heads/pr-12', undefined, true)]);
    assert.equal((b!.context as { strataUpstream: boolean }).strataUpstream, true);
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

  describe("the current branch's upstream", () => {
    const elsewhere = h('d');
    /** The badges of a row holding `row`, in a repository whose refs are `row` plus `others` on another commit. */
    const tracked = (row: Ref[], others: Ref[], headBranch: string | undefined) =>
      rowBadges(
        at,
        row,
        {
          head: headBranch === undefined ? at : elsewhere,
          headBranch,
          refs: [...others.map((r) => ({ ...r, hash: elsewhere })), ...row],
          remotes: ['origin', 'upstream'],
        },
        all,
      ).map((b) => [b.text, b.tracked]);

    it('marks the upstream on another commit', () => {
      assert.deepEqual(
        tracked([ref('refs/remotes/origin/main')], [ref('refs/heads/main', 'refs/remotes/origin/main')], 'main'),
        [['origin/main', true]],
      );
    });

    it('marks an upstream of another name', () => {
      assert.deepEqual(
        tracked(
          [ref('refs/remotes/origin/feature-x')],
          [ref('refs/heads/feat', 'refs/remotes/origin/feature-x')],
          'feat',
        ),
        [['origin/feature-x', true]],
      );
    });

    it('leaves other remote-tracking branches unmarked', () => {
      assert.deepEqual(
        tracked(
          [ref('refs/remotes/upstream/main'), ref('refs/remotes/origin/develop')],
          [ref('refs/heads/main', 'refs/remotes/origin/main')],
          'main',
        ),
        [
          ['upstream/main', false],
          ['origin/develop', false],
        ],
      );
    });

    it('marks nothing on a detached HEAD', () => {
      assert.deepEqual(
        tracked([ref('refs/remotes/origin/main')], [ref('refs/heads/main', 'refs/remotes/origin/main')], undefined),
        [
          ['HEAD', false],
          ['origin/main', false],
        ],
      );
    });

    it('marks nothing when the current branch has no upstream', () => {
      assert.deepEqual(tracked([ref('refs/remotes/origin/main')], [ref('refs/heads/main')], 'main'), [
        ['origin/main', false],
      ]);
    });
  });

  it('collapses badges past the kept ones into "+N", which stands for every ref it hides', () => {
    const tags = Array.from({ length: 5 }, (_, i) => ref(`refs/tags/t${i}`));
    const refs = [...tags, ref('refs/heads/y'), ref('refs/remotes/origin/y'), ref('refs/tags/z')];
    const badges = badgesOf(refs, 'main', () => 5);
    assert.equal(badges.length, 6);
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

describe('fitBadges', () => {
  const fit = (widths: number[], available: number, more: (hidden: number) => number = () => 20) =>
    fitBadges({ widths, more, minWidth: 30, gap: 4, available });

  it('keeps every badge that fits at natural width, with no "+N"', () => {
    assert.equal(fit([50, 50, 50], 158), 3);
    assert.equal(fit([], 100), 0);
  });
  it('keeps badges from the front while they and the "+N" fit', () => {
    assert.equal(fit([50, 50, 50, 50], 150), 2);
  });
  it('lets the last kept badge ellipsize rather than collapse it', () => {
    assert.equal(fit([100, 80], 150), 2);
    assert.equal(fit([100, 80, 80], 160), 2);
    assert.equal(fit([100, 80, 80], 150), 1);
  });
  it('sizes the "+N" by how many badges it hides', () => {
    assert.equal(
      fit([40, 40, 40, 40, 40], 135, (n) => n * 10),
      2,
    );
  });
  it('keeps the first badge even when nothing fits', () => {
    assert.equal(fit([100, 100], 10), 1);
  });
});

describe('refsLabel', () => {
  it('names each ref by its kind, the current branch, its upstream and merged remote names included', () => {
    const refs = [
      ref('refs/heads/main', 'refs/remotes/origin/main'),
      ref('refs/remotes/origin/main'),
      ref('refs/remotes/upstream/main'),
      ref('refs/heads/topic'),
      ref('refs/remotes/fork/other'),
      ref('refs/tags/v1'),
    ];
    // Merged into main's badge only when no other branch sits between them (badgeOrder runs first).
    assert.equal(
      refsLabel(badgesOf(refs)),
      'current branch main, also origin/main, upstream/main; branch topic; remote branch fork/other; tag v1',
    );
  });

  it("names a detached HEAD and the current branch's upstream", () => {
    const refs = [ref('refs/heads/main', 'refs/remotes/origin/main'), ref('refs/remotes/origin/main')];
    assert.equal(refsLabel(detached(refs)), 'detached HEAD; branch main, also origin/main');
    const apart = [ref('refs/heads/topic'), ref('refs/remotes/origin/main')];
    assert.equal(
      refsLabel(
        rowBadges(
          at,
          apart,
          {
            ...snapshot(apart, 'main'),
            refs: [...apart, { ...ref('refs/heads/main', 'refs/remotes/origin/main'), hash: h('d') }],
          },
          all,
        ),
      ),
      'branch topic; upstream origin/main',
    );
  });
});
