import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import type { Commit } from '../../src/core/commit.ts';
import {
  anchoredAt,
  describeStash,
  interleave,
  parseStashList,
  rowHash,
  stashLabel,
  stashPickItems,
  timeAgo,
  type ListRow,
  type StashEntry,
} from '../../src/core/stash.ts';
import { readStashDetails, readStashes, stashCache } from '../../src/git/stash.ts';
import { scenarios } from '../fixtures/scenarios.ts';
import { tempDir } from './helpers.ts';

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'a',
  GIT_AUTHOR_EMAIL: 'a@example.com',
  GIT_COMMITTER_NAME: 'a',
  GIT_COMMITTER_EMAIL: 'a@example.com',
};
const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

describe('parseStashList', () => {
  const h = (c: string) => c.repeat(40);
  const record = (...fields: string[]) => fields.map((f) => `${f}\0`).join('');
  const entry = (over: Partial<StashEntry>): StashEntry => ({
    hash: h('a'),
    index: 0,
    base: h('1'),
    untracked: undefined,
    message: '',
    branch: undefined,
    time: 0,
    autostash: false,
    anchor: { kind: 'base' },
    files: undefined,
    ...over,
  });

  it('reads index, base, untracked commit, message and time', () => {
    const out =
      record(
        h('a'),
        `${h('1')} ${h('2')} ${h('3')}`,
        'refs/stash@{0}',
        'WIP on main: 1111111 s',
        'WIP on main: 1111111 s',
        '100',
      ) +
      record(
        h('b'),
        `${h('1')} ${h('2')}`,
        'refs/stash@{1}',
        'On feature/x: my: message',
        'On feature/x: my: message',
        '90',
      );
    assert.deepEqual(parseStashList(out), [
      entry({ hash: h('a'), untracked: h('3'), message: 'WIP on main: 1111111 s', branch: 'main', time: 100 }),
      entry({ hash: h('b'), index: 1, message: 'On feature/x: my: message', branch: 'feature/x', time: 90 }),
    ]);
  });

  it("takes the branch from the stash commit's subject, which git's autostash keeps", () => {
    const out = record(h('c'), `${h('4')} ${h('5')}`, 'refs/stash@{0}', 'autostash', 'On f2: autostash', '80');
    assert.deepEqual(parseStashList(out), [
      entry({ hash: h('c'), base: h('4'), message: 'autostash', branch: 'f2', time: 80, autostash: true }),
    ]);
  });

  it("marks git's and Strata's autostash entries, and nothing else", () => {
    const parse = (message: string) =>
      parseStashList(record(h('d'), h('4'), 'refs/stash@{0}', message, message, '1'))[0]!.autostash;
    assert.equal(parse('autostash'), true);
    assert.equal(parse('On main: Strata autostash: reset to 1a2b3c4'), true);
    assert.equal(parse('Strata autostash: rebase'), true);
    assert.equal(parse("On main: Strata: changes set aside for the switch to 'x'"), true);
    assert.equal(parse('On main: Strata: before reset of main to 1a2b3c4'), false, 'a safety stash Strata never pops');
    assert.equal(parse('On main: autostash later'), false);
    assert.equal(parse('On main: not a Strata autostash: x'), false);
  });

  it('has no branch on a detached HEAD', () => {
    const out = record(h('d'), h('4'), 'refs/stash@{0}', 'On (no branch): detached', 'On (no branch): detached', '70');
    assert.equal(parseStashList(out)[0]!.branch, undefined);
  });

  it('is empty for no output', () => {
    assert.deepEqual(parseStashList(''), []);
  });
});

describe('stash rows', () => {
  const commit = (hash: string): Commit => ({
    hash,
    parents: [],
    author: 'a',
    authorEmail: 'a@example.com',
    authorTime: 0,
    commitTime: 0,
    subject: hash,
  });
  const stash = (hash: string, index: number, base: string, anchor: StashEntry['anchor'] = { kind: 'base' }) =>
    ({
      hash,
      index,
      base,
      untracked: undefined,
      message: `On main: ${hash}`,
      branch: 'main',
      time: 0,
      autostash: false,
      anchor,
      files: undefined,
    }) satisfies StashEntry;
  const shape = (rows: ListRow[]) => rows.map((r) => `${rowHash(r)}@${r.row}`);

  it('draws each stash directly above the commit it is anchored at, stash@{0} topmost', () => {
    const stashes = [stash('s2', 2, 'B'), stash('s0', 0, 'B'), stash('s1', 1, 'C')];
    const rows = interleave([commit('A'), commit('B'), commit('C')], 10, anchoredAt(stashes));
    assert.deepEqual(shape(rows), ['A@10', 's0@11', 's2@11', 'B@11', 's1@12', 'C@12']);
  });

  it('draws a displaced stash above its branch tip, not above its old base', () => {
    const moved = stash('s0', 0, 'old', { kind: 'tip', tip: 'A' });
    assert.deepEqual(shape(interleave([commit('A'), commit('old')], 0, anchoredAt([moved]))), ['s0@0', 'A@0', 'old@1']);
  });

  it('keeps the stashes made on a commit right above it when a displaced stash is drawn there too', () => {
    const stashes = [stash('s0', 0, 'A'), stash('s1', 1, 'old', { kind: 'tip', tip: 'A' }), stash('s2', 2, 'A')];
    const rows = interleave([commit('A'), commit('old')], 0, anchoredAt(stashes));
    assert.deepEqual(shape(rows), ['s1@0', 's0@0', 's2@0', 'A@0', 'old@1']);
  });

  it('leaves out stashes whose commit is not in the page', () => {
    assert.deepEqual(shape(interleave([commit('A')], 0, anchoredAt([stash('s0', 0, 'Z')]))), ['A@0']);
  });

  const summary = { staged: 1, unstaged: 2, conflicted: 0, untracked: 1, submodules: 0 };

  it('draws the uncommitted changes above HEAD and the stashes on it', () => {
    const rows = interleave([commit('A'), commit('B')], 5, anchoredAt([stash('s0', 0, 'B')]), { head: 'B', summary });
    assert.deepEqual(shape(rows), ['A@5', 'changes@6', 's0@6', 'B@6']);
    assert.deepEqual(rows[1], { kind: 'changes', changes: summary, row: 6 });
  });

  it('leaves out the uncommitted changes when HEAD is not in the page', () => {
    assert.deepEqual(shape(interleave([commit('A')], 0, new Map(), { head: 'Z', summary })), ['A@0']);
  });

  it('draws the uncommitted changes first, with no layout row, before the first commit on the branch', () => {
    const changes = { head: undefined, summary };
    assert.deepEqual(shape(interleave([], 0, new Map(), changes)), ['changes@-1']);
    assert.deepEqual(shape(interleave([commit('A')], 0, new Map(), changes)), ['changes@-1', 'A@0']);
    assert.deepEqual(shape(interleave([commit('B')], 1, new Map(), changes)), ['B@1']);
  });

  it('gives the same rows whether a history is interleaved whole or page by page', () => {
    const commits = Array.from({ length: 40 }, (_, i) => commit(`c${i}`));
    const stashes = [0, 0, 7, 19, 39].map((at, i) => stash(`s${i}`, i, `c${at}`));
    const anchors = anchoredAt(stashes);
    const changes = { head: 'c7', summary };
    const whole = interleave(commits, 0, anchors, changes);
    assert.ok(whole.some((r) => r.kind === 'changes'));
    for (let i = 0; i <= commits.length; i++) {
      const split = [
        ...interleave(commits.slice(0, i), 0, anchors, changes),
        ...interleave(commits.slice(i), i, anchors, changes),
      ];
      assert.deepEqual(split, whole, `split at ${i}`);
    }
  });
});

describe('stash labels', () => {
  const s = (over: Partial<StashEntry>): StashEntry => ({
    hash: 'w'.repeat(40),
    index: 1,
    base: 'b'.repeat(40),
    untracked: undefined,
    message: 'On feature: half-done lexer',
    branch: 'feature',
    time: 0,
    autostash: false,
    anchor: { kind: 'base' },
    files: { changed: 3, untracked: 1 },
    ...over,
  });

  it('splits off the "On <branch>:" or "WIP on <branch>:" prefix', () => {
    assert.deepEqual(stashLabel(s({})), { prefix: 'On feature:', text: 'half-done lexer' });
    assert.deepEqual(stashLabel(s({ message: 'WIP on main: 1a2b3c4 Add lexer' })), {
      prefix: 'WIP on main:',
      text: '1a2b3c4 Add lexer',
    });
    assert.deepEqual(stashLabel(s({ message: 'autostash', autostash: true })), {
      prefix: undefined,
      text: 'autostash',
    });
  });

  it('describes a stash with its base, its files and when it was made', () => {
    assert.equal(
      describeStash(s({}), { short: '4b5c6d7', subject: 'Add lexer' }, '13:40'),
      'Stash stash@{1}: On feature: half-done lexer. Based on 4b5c6d7 "Add lexer". 3 files changed, 1 untracked. Stashed 13:40.',
    );
    assert.equal(
      describeStash(s({ files: { changed: 1, untracked: 0 } }), { short: '4b5c6d7', subject: undefined }, '13:40'),
      'Stash stash@{1}: On feature: half-done lexer. Based on 4b5c6d7. 1 file changed. Stashed 13:40.',
    );
    assert.equal(
      describeStash(s({ files: undefined }), { short: '4b5c6d7', subject: undefined }, '13:40'),
      'Stash stash@{1}: On feature: half-done lexer. Based on 4b5c6d7. Stashed 13:40.',
    );
  });

  it('says when its base is no longer on its branch', () => {
    const moved = s({ index: 0, message: 'autostash', autostash: true, anchor: { kind: 'tip', tip: 't'.repeat(40) } });
    assert.equal(
      describeStash(moved, { short: '776d4b4', subject: undefined }, '13:40'),
      "Stash stash@{0}: autostash. Based on 776d4b4, no longer on 'feature'. 3 files changed, 1 untracked. Stashed 13:40.",
    );
  });
});

describe('Show Stashes items', () => {
  const now = 1_700_000_000;
  const entry = (index: number, branch: string, anchor: StashEntry['anchor'] = { kind: 'base' }): StashEntry => ({
    hash: `w${index}`.padEnd(40, '0'),
    index,
    base: `b${index}`.padEnd(40, '0'),
    untracked: undefined,
    message: `On ${branch}: work ${index}`,
    branch,
    time: now - index * 86_400,
    autostash: false,
    anchor,
    files: undefined,
  });
  const stashes = [
    entry(0, 'feature', { kind: 'tip', tip: 't'.repeat(40) }),
    entry(1, 'main'),
    entry(2, 'feature'),
    entry(3, 'main'),
  ];
  const shown = {
    [stashes[0]!.hash]: 'drawn',
    [stashes[1]!.hash]: 'notLoaded',
    [stashes[2]!.hash]: 'notInView',
    [stashes[3]!.hash]: 'hidden',
  } as const;

  it('lists the stashes made on the current branch first, each saying where its row is', () => {
    assert.deepEqual(stashPickItems(stashes, shown, 'feature', now), [
      { kind: 'separator', label: 'On feature (current)' },
      {
        kind: 'stash',
        hash: stashes[0]!.hash,
        label: 'stash@{0}  On feature: work 0',
        description: 'just now',
        detail: 'In the graph above ttttttt',
      },
      {
        kind: 'stash',
        hash: stashes[2]!.hash,
        label: 'stash@{2}  On feature: work 2',
        description: '2 days ago',
        detail: 'Not in this view (filter, first parent, or its branch was deleted)',
      },
      { kind: 'separator', label: 'Elsewhere' },
      {
        kind: 'stash',
        hash: stashes[1]!.hash,
        label: 'stash@{1}  On main: work 1',
        description: 'yesterday',
        detail: 'Not loaded yet: Enter searches further down the history',
      },
      {
        kind: 'stash',
        hash: stashes[3]!.hash,
        label: 'stash@{3}  On main: work 3',
        description: '3 days ago',
        detail: 'Stash rows are hidden: Enter shows them',
      },
    ]);
  });

  it('says a stash no start point of the graph reaches is not in it, which no search changes', () => {
    const lost = entry(4, 'main', { kind: 'unreachable' });
    const [item] = stashPickItems([lost], { [lost.hash]: 'notInView' }, undefined, now);
    assert.equal(
      item?.kind === 'stash' && item.detail,
      `Not in the graph: no branch or HEAD contains its base commit ${lost.base.slice(0, 7)}`,
    );
  });

  it('has no separators when every stash is in one group', () => {
    assert.deepEqual(
      stashPickItems(stashes, shown, 'other', now).map((i) => i.kind),
      ['stash', 'stash', 'stash', 'stash'],
    );
    assert.ok(stashPickItems(stashes, shown, undefined, now).every((i) => i.kind === 'stash'));
  });

  it('says how long ago something happened in the largest whole unit', () => {
    assert.equal(timeAgo(now - 30, now), 'just now');
    assert.equal(timeAgo(now - 5 * 60, now), '5 minutes ago');
    assert.equal(timeAgo(now - 3 * 3600, now), '3 hours ago');
    assert.equal(timeAgo(now - 86_400, now), 'yesterday');
    assert.equal(timeAgo(now - 21 * 86_400, now), '3 weeks ago');
    assert.equal(timeAgo(now - 400 * 86_400, now), 'last year');
  });
});

describe('readStashes', () => {
  const root = tempDir('stash');
  const dir = join(root, 'repo');
  before(() => {
    mkdirSync(dir);
    run(dir, 'init', '--quiet', '-b', 'main');
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    run(dir, 'add', '.');
    run(dir, 'commit', '--quiet', '-m', 'root');
  });

  it('is empty without stashes', async () => {
    assert.deepEqual(await readStashes('git', dir), []);
  });

  it('lists every stash, newest first, with its untracked commit', async () => {
    appendFileSync(join(dir, 'a.txt'), 'b\n');
    run(dir, 'stash', 'push', '--quiet', '-m', 'first');
    appendFileSync(join(dir, 'a.txt'), 'c\n');
    writeFileSync(join(dir, 'new.txt'), 'u\n');
    run(dir, 'stash', 'push', '--quiet', '--include-untracked', '-m', 'second');
    const list = await readStashes('git', dir);
    assert.deepEqual(
      list.map((s) => [s.index, s.message, s.branch, s.untracked !== undefined]),
      [
        [0, 'On main: second', 'main', true],
        [1, 'On main: first', 'main', false],
      ],
    );
    assert.equal(list[0]!.hash, run(dir, 'rev-parse', 'stash@{0}'));
    assert.equal(list[0]!.base, run(dir, 'rev-parse', 'HEAD'));
  });

  it('counts the changed and the untracked files of each stash', async () => {
    const list = await readStashes('git', dir);
    assert.deepEqual(
      list.map((s) => s.files),
      [
        { changed: 1, untracked: 1 },
        { changed: 1, untracked: 0 },
      ],
    );
  });

  it("anchors a stash at its base while the base is on the stash's branch", async () => {
    assert.deepEqual(
      (await readStashes('git', dir)).map((s) => s.anchor),
      [{ kind: 'base' }, { kind: 'base' }],
    );
  });

  it('draws a stash above its branch tip once its base left the branch, and notices the branch moving', async () => {
    const cache = stashCache();
    run(dir, 'switch', '--quiet', '-c', 'topic');
    writeFileSync(join(dir, 'b.txt'), 'b\n');
    run(dir, 'add', '.');
    run(dir, 'commit', '--quiet', '-m', 'topic work');
    appendFileSync(join(dir, 'b.txt'), 'wip\n');
    run(dir, 'stash', 'push', '--quiet', '-m', 'on topic');
    assert.deepEqual((await readStashes('git', dir, cache))[0]!.anchor, { kind: 'base' });
    // Rewriting the branch (amend, rebase, reset) leaves the stash's base behind.
    run(dir, 'commit', '--quiet', '--amend', '-m', 'topic work, reworded');
    const tip = run(dir, 'rev-parse', 'HEAD');
    assert.deepEqual((await readStashes('git', dir, cache))[0]!.anchor, { kind: 'tip', tip });
  });

  it('keeps a stash at its base while another branch or remote-tracking branch still holds the base', async () => {
    const tip = run(dir, 'rev-parse', 'HEAD');
    const base = run(dir, 'rev-parse', 'stash@{0}^1');
    // A hard reset that origin/topic still covers: the base row stays in the graph.
    run(dir, 'update-ref', 'refs/remotes/origin/topic', base);
    assert.deepEqual((await readStashes('git', dir))[0]!.anchor, { kind: 'base' });
    run(dir, 'update-ref', '-d', 'refs/remotes/origin/topic');
    assert.deepEqual((await readStashes('git', dir))[0]!.anchor, { kind: 'tip', tip });
  });

  it('anchors a stash at its base when its branch is gone, while a ref still holds the base', async () => {
    const base = run(dir, 'rev-parse', 'stash@{0}^1');
    run(dir, 'switch', '--quiet', 'main');
    run(dir, 'branch', '--quiet', '-D', 'topic');
    assert.deepEqual((await readStashes('git', dir))[0]!.anchor, { kind: 'unreachable' });
    run(dir, 'update-ref', 'refs/remotes/origin/topic', base);
    assert.deepEqual((await readStashes('git', dir))[0]!.anchor, { kind: 'base' });
    run(dir, 'update-ref', '-d', 'refs/remotes/origin/topic');
  });

  it('finds a stash made on a detached HEAD drawn only while HEAD or a ref holds its base', async () => {
    run(dir, 'switch', '--quiet', '--detach', 'main');
    writeFileSync(join(dir, 'c.txt'), 'c\n');
    run(dir, 'add', '.');
    run(dir, 'commit', '--quiet', '-m', 'detached work');
    appendFileSync(join(dir, 'c.txt'), 'wip\n');
    run(dir, 'stash', 'push', '--quiet', '-m', 'detached');
    assert.deepEqual((await readStashes('git', dir))[0]!.anchor, { kind: 'base' });
    run(dir, 'switch', '--quiet', 'main');
    assert.deepEqual((await readStashes('git', dir))[0]!.anchor, { kind: 'unreachable' });
  });

  it('anchors at the base and leaves files uncounted when git takes longer than allowed', async () => {
    const [s] = await readStashes('git', dir, stashCache(), 0);
    assert.deepEqual([s!.anchor, s!.files], [{ kind: 'base' }, undefined]);
  });
});

describe('readStashDetails', () => {
  const dir = join(tempDir('stash-details'), 'repo');
  before(() => {
    scenarios.stashes().write(dir);
  });

  it('lists the changes against the base, what of them was staged, and the untracked files', async () => {
    const d = await readStashDetails('git', dir, run(dir, 'rev-parse', 'stash@{2}'));
    assert.equal(d.message, 'On feature/search: half-done ranking UI');
    assert.equal(d.base, run(dir, 'rev-parse', 'feature/search'));
    assert.deepEqual(d.files, [
      { status: 'M', path: 'feature_search.txt' },
      { status: 'A', path: 'src/ranking.ts' },
    ]);
    assert.deepEqual(d.stash, {
      staged: ['src/ranking.ts'],
      untracked: {
        hash: run(dir, 'rev-parse', 'stash@{2}^3'),
        files: [{ status: 'A', path: 'notes/ranking-ideas.md' }],
      },
    });
  });

  it('has no untracked files for a stash made without them', async () => {
    const d = await readStashDetails('git', dir, run(dir, 'rev-parse', 'stash@{3}'));
    assert.deepEqual(d.stash, { staged: [], untracked: undefined });
  });
});
