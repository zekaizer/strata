import * as assert from 'node:assert/strict';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import type { Commit } from '../../src/core/commit.ts';
import { initialLaneState, layoutPage } from '../../src/core/layout.ts';
import { laneHead, type RefSnapshot } from '../../src/core/refs.ts';
import { LogReader, type LogOptions } from '../../src/git/log-reader.ts';
import { readRefs } from '../../src/git/refs.ts';
import { scenarios } from '../fixtures/scenarios.ts';
import { git, tempDir } from './helpers.ts';

const snapshot = (refs: [string, string][], head?: string): RefSnapshot => ({
  head,
  headBranch: undefined,
  refs: refs.map(([name, hash]) => ({
    name,
    short: name.replace(/^refs\/(heads|remotes|tags)\//, ''),
    kind: name.startsWith('refs/heads/') ? 'branch' : name.startsWith('refs/remotes/') ? 'remote' : 'tag',
    hash,
  })),
  remotes: [],
  worktrees: [],
});

describe('laneHead', () => {
  const refs: [string, string][] = [
    ['refs/heads/main', 'a'],
    ['refs/heads/topic', 'b'],
    ['refs/remotes/origin/main', 'c'],
    ['refs/tags/v1', 'c'],
  ];

  it("is HEAD's commit in a view of all refs, on a branch or detached", () => {
    assert.equal(laneHead(snapshot(refs, 'a'), null), 'a');
    assert.equal(laneHead(snapshot(refs, 'd'), null), 'd');
  });

  it('is none on an unborn branch', () => {
    assert.equal(laneHead(snapshot([]), null), undefined);
    assert.equal(laneHead(snapshot(refs), ['refs/heads/main']), undefined);
  });

  it("is HEAD's commit under a ref filter with a picked branch, remote-tracking branch or tag at it", () => {
    assert.equal(laneHead(snapshot(refs, 'a'), ['refs/heads/topic', 'refs/heads/main']), 'a');
    assert.equal(laneHead(snapshot(refs, 'c'), ['refs/remotes/origin/main']), 'c');
    assert.equal(laneHead(snapshot(refs, 'c'), ['refs/tags/v1']), 'c');
  });

  it('is none under a ref filter whose picked refs are all at other commits', () => {
    assert.equal(laneHead(snapshot(refs, 'a'), ['refs/heads/topic']), undefined);
    assert.equal(laneHead(snapshot(refs, 'd'), ['refs/heads/main', 'refs/tags/v1']), undefined);
    assert.equal(laneHead(snapshot(refs, 'a'), []), undefined);
  });
});

async function readAll(opts: LogOptions): Promise<Commit[]> {
  const r = new LogReader(opts);
  const out: Commit[] = [];
  try {
    for (;;) {
      const page = await r.next(4);
      out.push(...page.commits);
      if (page.done) return out;
    }
  } finally {
    r.dispose();
  }
}

describe('laneHead: the commit it gives is in the history git lists', () => {
  const dir = join(tempDir('lane-head'), 'paths');
  const sha = (rev: string) => git(dir, 'rev-parse', rev);
  before(() => {
    scenarios.paths().write(dir);
  });

  /** HEAD on a branch, or detached at a commit no ref is at. */
  const heads = [
    { name: 'the newest branch', set: () => git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main') },
    { name: 'an older branch', set: () => git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/release/2.x') },
    { name: 'an unmerged branch', set: () => git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/feature/sso') },
    { name: 'detached inside main', set: () => git(dir, 'update-ref', '--no-deref', 'HEAD', sha('main~4')) },
    { name: 'detached off a merged side', set: () => git(dir, 'update-ref', '--no-deref', 'HEAD', sha('main~3^2')) },
  ];
  const filters: (string[] | null)[] = [
    null,
    ['refs/heads/main'],
    ['refs/heads/release/2.x'],
    ['refs/heads/feature/sso', 'refs/remotes/origin/main'],
    ['refs/tags/v2.1.0'],
  ];

  for (const head of heads) {
    it(`HEAD ${head.name}: it arrives and takes column 0 in every view that holds the column`, async () => {
      head.set();
      const snap = await readRefs('git', dir);
      assert.equal(snap.head, sha('HEAD'));
      let held = 0;
      for (const refs of filters) {
        const hash = laneHead(snap, refs);
        if (hash === undefined) continue;
        held++;
        for (const firstParent of [false, true]) {
          for (const paths of [undefined, ['src/auth/session.ts'], ['src/ui/']]) {
            const view = JSON.stringify({ refs, firstParent, paths });
            const commits = await readAll({ git: 'git', cwd: dir, refs: refs ?? undefined, firstParent, paths });
            const at = commits.findIndex((c) => c.hash === hash);
            assert.ok(at >= 0, `HEAD is not listed: ${view}`);
            const { rows, state } = layoutPage(initialLaneState(hash), commits);
            assert.equal(rows[at]!.lane, 0, view);
            assert.equal(state.head, null, view);
          }
        }
      }
      assert.ok(held >= 1, 'the view of all refs holds the column');
    });
  }

  it('holds no column when the ref filter leaves HEAD out of the history', async () => {
    git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    const snap = await readRefs('git', dir);
    const refs = ['refs/heads/release/2.x'];
    const commits = await readAll({ git: 'git', cwd: dir, refs });
    assert.ok(!commits.some((c) => c.hash === snap.head));
    assert.equal(laneHead(snap, refs), undefined);
    assert.equal(layoutPage(initialLaneState(laneHead(snap, refs)), commits).rows[0]!.lane, 0);
  });
});
