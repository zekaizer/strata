import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { LogReader, type LogOptions } from '../../src/git/log-reader.ts';
import { RepoBuilder } from '../fixtures/builder.ts';
import { scenarios } from '../fixtures/scenarios.ts';
import { git, tempDir } from './helpers.ts';

// Tags are not start points by default (see ADR 0001); their commits show when reachable from a branch.
const REV_ARGS = ['--topo-order', '--branches', '--remotes', 'HEAD'];

async function readAll(opts: LogOptions, pageSize: number): Promise<string[]> {
  const r = new LogReader(opts);
  const out: string[] = [];
  try {
    for (;;) {
      const page = await r.next(pageSize);
      assert.ok(page.commits.length <= pageSize);
      if (!page.done) assert.equal(page.commits.length, pageSize, 'only the last page may be short');
      out.push(...page.commits.map((c) => c.hash));
      if (page.done) return out;
    }
  } finally {
    r.dispose();
  }
}

describe('LogReader', () => {
  const root = tempDir('reader');
  let large: string;
  before(() => {
    large = join(root, 'large');
    scenarios.large().write(large);
    scenarios.branchy().write(join(root, 'branchy'));
  });

  for (const size of [1, 7, 100, 4999, 5000, 10_000]) {
    it(`pages through history in git's order (page size ${size})`, async () => {
      const pageable = size === 1 ? join(root, 'branchy') : large;
      const expected = git(pageable, 'rev-list', ...REV_ARGS).split('\n');
      assert.deepEqual(await readAll({ git: 'git', cwd: pageable }, size), expected);
    });
  }

  it('follows first parents only when asked', async () => {
    const expected = git(large, 'rev-list', '--first-parent', ...REV_ARGS).split('\n');
    assert.deepEqual(await readAll({ git: 'git', cwd: large, firstParent: true }, 50), expected);
  });

  it('reports only the first parent in first-parent mode', async () => {
    // git prints every parent in %P even with --first-parent; the graph must not await the others.
    const r = new LogReader({ git: 'git', cwd: large, firstParent: true });
    const { commits } = await r.next(5000);
    r.dispose();
    const expected = git(large, 'rev-list', '--first-parent', '--parents', ...REV_ARGS)
      .split('\n')
      .map((l) => l.split(' ').slice(1, 2));
    assert.deepEqual(
      commits.map((c) => c.parents),
      expected,
    );
  });

  it('limits history to the given refs', async () => {
    const dir = join(root, 'branchy');
    const refs = ['refs/heads/wip/experiment', 'refs/heads/feature/login'];
    const expected = git(dir, 'rev-list', '--topo-order', ...refs).split('\n');
    assert.deepEqual(await readAll({ git: 'git', cwd: dir, refs }, 7), expected);
  });

  it('leaves out commits reachable only from tags unless a tag is selected', async () => {
    const dir = join(root, 'tag-only');
    const b = new RepoBuilder();
    const base = b.commit('main', 'base');
    b.commit('main', 'main tip');
    const hotfix = b.commit('refs/strata-fixture/tmp', 'released from a deleted branch', { parents: [base] });
    b.tag('v1-hotfix', hotfix, 'hotfix release');
    b.write(dir);
    git(dir, 'update-ref', '-d', 'refs/strata-fixture/tmp');
    const subjects = async (refs?: string[]) => {
      const r = new LogReader({ git: 'git', cwd: dir, refs });
      const { commits } = await r.next(100);
      r.dispose();
      return commits.map((c) => c.subject);
    };
    assert.deepEqual(await subjects(), ['main tip', 'base']);
    assert.deepEqual(await subjects(['refs/tags/v1-hotfix']), ['released from a deleted branch', 'base']);
  });

  it('rejects ref names that are not full refs/ names', async () => {
    const r = new LogReader({ git: 'git', cwd: join(root, 'branchy'), refs: ['--all'] });
    await assert.rejects(r.next(1), /invalid ref/);
    r.dispose();
  });

  it('includes a detached HEAD that no ref points at', async () => {
    const dir = join(root, 'detached');
    scenarios.linear().write(dir);
    git(dir, 'checkout', '--quiet', '--detach');
    execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'detached work'], {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'a',
        GIT_AUTHOR_EMAIL: 'a@b',
        GIT_COMMITTER_NAME: 'a',
        GIT_COMMITTER_EMAIL: 'a@b',
      },
    });
    const head = git(dir, 'rev-parse', 'HEAD');
    const all = await readAll({ git: 'git', cwd: dir }, 10);
    assert.equal(all[0], head);
    assert.equal(all.length, 31);
  });

  it("starts from other worktrees' detached HEADs too, skipping missing ones", async () => {
    const dir = join(root, 'worktree-heads');
    scenarios.linear().write(dir);
    const other = join(root, 'worktree-heads-other');
    git(dir, 'worktree', 'add', '--quiet', '--detach', other, 'HEAD~2');
    execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'work in the other worktree'], {
      cwd: other,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'a',
        GIT_AUTHOR_EMAIL: 'a@b',
        GIT_COMMITTER_NAME: 'a',
        GIT_COMMITTER_EMAIL: 'a@b',
      },
    });
    const head = git(other, 'rev-parse', 'HEAD');
    const missing = 'f'.repeat(40);
    const all = await readAll({ git: 'git', cwd: dir, heads: [head, missing] }, 10);
    assert.equal(all.length, 31);
    assert.ok(all.includes(head));
    assert.ok(!(await readAll({ git: 'git', cwd: dir }, 10)).includes(head), 'not without it');
    const picked = await readAll({ git: 'git', cwd: dir, refs: ['refs/heads/main'], heads: [head] }, 10);
    assert.ok(!picked.includes(head), 'only with every branch shown');
  });

  it('rejects worktree heads that are not commit ids', async () => {
    const r = new LogReader({ git: 'git', cwd: join(root, 'branchy'), heads: ['--all'] });
    await assert.rejects(r.next(1), /invalid commit id/);
    r.dispose();
  });

  it('returns an empty, finished page for a repository without commits', async () => {
    const dir = join(root, 'empty');
    mkdirSync(dir);
    git(dir, 'init', '--quiet');
    assert.deepEqual(await readAll({ git: 'git', cwd: dir }, 10), []);
  });

  it('keeps returning finished empty pages after the end', async () => {
    const r = new LogReader({ git: 'git', cwd: join(root, 'branchy') });
    await r.next(1000);
    assert.deepEqual(await r.next(10), { commits: [], done: true });
    r.dispose();
  });

  it('serves concurrent requests in call order', async () => {
    const dir = join(root, 'branchy');
    const r = new LogReader({ git: 'git', cwd: dir });
    const [a, b] = await Promise.all([r.next(5), r.next(5)]);
    r.dispose();
    const expected = git(dir, 'rev-list', ...REV_ARGS).split('\n');
    assert.deepEqual(
      [...a.commits, ...b.commits].map((c) => c.hash),
      expected.slice(0, 10),
    );
  });

  it('rejects with git stderr when the directory is not a repository', async () => {
    const dir = join(root, 'not-a-repo');
    mkdirSync(dir);
    const r = new LogReader({ git: 'git', cwd: dir });
    // git's message is localized; only require that it is surfaced.
    await assert.rejects(r.next(10), (e: Error) => e.message.length > 0 && !/disposed/.test(e.message));
    r.dispose();
  });

  it('rejects pending and later requests after dispose', async () => {
    const r = new LogReader({ git: 'git', cwd: large });
    await r.next(10);
    r.dispose();
    await assert.rejects(r.next(10), /disposed/);
  });
});
