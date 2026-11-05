import * as assert from 'node:assert/strict';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { parseFindQuery } from '../../src/core/find.ts';
import { findCommits, findExact, locateCommit, type FindBatch } from '../../src/git/find.ts';
import type { LogOptions } from '../../src/git/log-reader.ts';
import { RepoBuilder } from '../fixtures/builder.ts';
import { scenarios } from '../fixtures/scenarios.ts';
import { git, tempDir } from './helpers.ts';

const VIEW = ['--topo-order', '--branches', '--remotes', 'HEAD'];

async function findAll(opts: LogOptions, input: string, cap = 10_000): Promise<FindBatch[]> {
  const batches: FindBatch[] = [];
  await findCommits({ ...opts, query: parseFindQuery(input)!, cap, signal: new AbortController().signal }, (b) => {
    batches.push(b);
  });
  return batches;
}
const hashes = (batches: FindBatch[]) => batches.flatMap((b) => b.hits.map((h) => h.hash));

describe('findCommits', () => {
  const root = tempDir('find');
  const large = join(root, 'large');
  const small = join(root, 'small');
  before(() => {
    scenarios.large().write(large);
    const b = new RepoBuilder();
    b.commit('main', 'Add parser');
    b.commit('main', 'Fix descriptor leak\n\nReported-by: Grace Hopper', { author: 'Ada Lovelace <ada@example.com>' });
    b.commit('main', 'Tidy LEAK checks', { author: 'Grace Hopper <grace@example.com>' });
    b.commit('main', 'Use [a-z]+ literally', { author: 'Grace Hopper <grace@example.com>' });
    b.write(small);
  });

  it("hands out the view's matching commits in the graph's order, in batches, the last one done", async () => {
    const batches = await findAll({ git: 'git', cwd: large }, 'WORK ON');
    const expected = git(large, 'rev-list', '-i', '-F', '--grep=work on', ...VIEW).split('\n');
    assert.ok(expected.length > 200, 'more than one batch');
    assert.deepEqual(hashes(batches), expected);
    assert.ok(batches.length > 1);
    assert.deepEqual(
      batches.map((b) => b.done),
      [...batches.slice(1).map(() => false), true],
    );
    const order = git(large, 'rev-list', ...VIEW).split('\n');
    const at = expected.map((h) => order.indexOf(h));
    assert.deepEqual(
      at,
      [...at].sort((a, b) => a - b),
      'a subsequence of the graph order',
    );
    const first = batches[0]!.hits[0]!;
    assert.deepEqual(first, {
      hash: expected[0],
      subject: git(large, 'log', '-1', '--format=%s', expected[0]!),
      author: 'Ada Lovelace',
      authorTime: Number(git(large, 'log', '-1', '--format=%at', expected[0]!)),
    });
  });

  it('follows the view: first parent and selected refs', async () => {
    for (const opts of [{ firstParent: true }, { refs: ['refs/heads/b3', 'refs/heads/b5'] }]) {
      const view = opts.refs ?? ['--first-parent', '--branches', '--remotes', 'HEAD'];
      const expected = git(large, 'rev-list', '--topo-order', '-i', '-F', '--grep=work on', ...view).split('\n');
      assert.deepEqual(hashes(await findAll({ git: 'git', cwd: large, ...opts }, 'work on')), expected);
    }
  });

  it('searches the body too, ignoring case, as a fixed string', async () => {
    const subjects = async (input: string) =>
      (await findAll({ git: 'git', cwd: small }, input)).flatMap((b) => b.hits.map((h) => h.subject));
    assert.deepEqual(await subjects('leak'), ['Tidy LEAK checks', 'Fix descriptor leak']);
    assert.deepEqual(await subjects('reported-by: grace'), ['Fix descriptor leak']);
    assert.deepEqual(await subjects('[a-z]+'), ['Use [a-z]+ literally']);
  });

  it('matches the author by name or email, and both author and text when both are given', async () => {
    const subjects = async (input: string) =>
      (await findAll({ git: 'git', cwd: small }, input)).flatMap((b) => b.hits.map((h) => h.subject));
    assert.deepEqual(await subjects('author:grace'), ['Use [a-z]+ literally', 'Tidy LEAK checks']);
    assert.deepEqual(await subjects('author:"ADA@EXAMPLE"'), ['Fix descriptor leak', 'Add parser']);
    assert.deepEqual(await subjects('author:grace leak'), ['Tidy LEAK checks']);
  });

  it('stops after the cap and says more match', async () => {
    const batches = await findAll({ git: 'git', cwd: large }, 'work on', 250);
    const expected = git(large, 'rev-list', '-i', '-F', '--grep=work on', '--max-count=250', ...VIEW).split('\n');
    assert.deepEqual(hashes(batches), expected);
    assert.deepEqual(batches.at(-1), { ...batches.at(-1), done: true, capped: true });
    assert.ok(batches.slice(0, -1).every((b) => !b.capped));
  });

  it('is not capped when exactly the cap matches', async () => {
    const batches = await findAll({ git: 'git', cwd: small }, 'leak', 2);
    assert.equal(hashes(batches).length, 2);
    assert.equal(batches.at(-1)!.capped, false);
  });

  it('hands out nothing more once stopped, and rejects', async () => {
    const stop = new AbortController();
    const batches: FindBatch[] = [];
    const found = findCommits(
      { git: 'git', cwd: large, query: parseFindQuery('work on')!, cap: 10_000, signal: stop.signal },
      (b) => {
        batches.push(b);
        stop.abort();
      },
    );
    await assert.rejects(found);
    assert.equal(batches.length, 1);
    assert.equal(batches[0]!.done, false);
  });

  it('rejects ref names that are not full refs/ names', async () => {
    await assert.rejects(findAll({ git: 'git', cwd: small, refs: ['--all'] }, 'leak'), /invalid ref/);
  });
});

describe('findExact', () => {
  const root = tempDir('exact');
  const dir = join(root, 'branchy');
  before(() => {
    scenarios.branchy().write(dir);
  });

  it('finds the commit a hash prefix names, with its subject', async () => {
    const head = git(dir, 'rev-parse', 'HEAD');
    for (const prefix of [head.slice(0, 7), head]) {
      assert.deepEqual(await findExact('git', dir, prefix), [
        {
          hash: head,
          subject: git(dir, 'log', '-1', '--format=%s', head),
          author: git(dir, 'log', '-1', '--format=%aN', head),
          authorTime: Number(git(dir, 'log', '-1', '--format=%at', head)),
        },
      ]);
    }
  });

  it('finds no commit for an unknown prefix or one naming only a tree', async () => {
    assert.deepEqual(await findExact('git', dir, '0000000'), []);
    const tree = git(dir, 'rev-parse', 'HEAD^{tree}');
    assert.deepEqual(await findExact('git', dir, tree), []);
  });
});

describe('locateCommit', () => {
  const root = tempDir('locate');
  const large = join(root, 'large');
  const tagOnly = join(root, 'tag-only');
  before(() => {
    scenarios.large().write(large);
    const b = new RepoBuilder();
    const base = b.commit('main', 'base');
    b.commit('main', 'main tip');
    const hotfix = b.commit('refs/strata-fixture/tmp', 'released from a deleted branch', { parents: [base] });
    b.tag('v1-hotfix', hotfix, 'hotfix release');
    b.write(tagOnly);
    git(tagOnly, 'update-ref', '-d', 'refs/strata-fixture/tmp');
  });
  const signal = new AbortController().signal;

  it("finds the commit's index in the view's order", async () => {
    const order = git(large, 'rev-list', ...VIEW).split('\n');
    for (const i of [0, 1234, order.length - 1])
      assert.deepEqual(await locateCommit({ git: 'git', cwd: large, hash: order[i]!, signal }), {
        position: i,
        reachedBy: [],
      });
  });

  it('names the refs that reach a commit the view leaves out', async () => {
    const hotfix = git(tagOnly, 'rev-parse', 'v1-hotfix^{commit}');
    assert.deepEqual(await locateCommit({ git: 'git', cwd: tagOnly, hash: hotfix, signal }), {
      position: undefined,
      reachedBy: ['refs/tags/v1-hotfix'],
    });
    const base = git(tagOnly, 'rev-parse', 'main~1');
    assert.deepEqual(
      await locateCommit({ git: 'git', cwd: tagOnly, hash: base, signal, refs: ['refs/tags/v1-hotfix'] }),
      {
        position: 1,
        reachedBy: [],
      },
    );
    const tip = git(tagOnly, 'rev-parse', 'main');
    assert.deepEqual(
      await locateCommit({ git: 'git', cwd: tagOnly, hash: tip, signal, refs: ['refs/tags/v1-hotfix'] }),
      {
        position: undefined,
        reachedBy: ['refs/heads/main'],
      },
    );
  });

  it('rejects once stopped', async () => {
    const stop = new AbortController();
    stop.abort();
    const order = git(large, 'rev-list', ...VIEW).split('\n');
    await assert.rejects(locateCommit({ git: 'git', cwd: large, hash: order.at(-1)!, signal: stop.signal }));
  });
});
