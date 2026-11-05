import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { before, describe, it } from 'node:test';
import type { Ref, RefSnapshot } from '../../src/core/refs.ts';
import { parseAfter, parseFirstIn, parseOn, whereAsk } from '../../src/core/where.ts';
import { readRefs } from '../../src/git/refs.ts';
import type { GitLimits } from '../../src/git/run.ts';
import { readWhere } from '../../src/git/where.ts';
import { tempDir } from './helpers.ts';

const h = (c: string) => c.repeat(40);
const ref = (name: string, hash = h('a')): Ref => {
  const [, kind, short] = /^refs\/(heads|remotes|tags)\/(.*)$/.exec(name)!;
  return { name, short: short!, kind: kind === 'heads' ? 'branch' : kind === 'remotes' ? 'remote' : 'tag', hash };
};
const snapshot = (refs: Ref[], headBranch: string | undefined = 'main'): RefSnapshot => ({
  head: h('a'),
  headBranch,
  refs,
  remotes: ['origin'],
  worktrees: [],
});
const none = new Set<string>();

describe('parseFirstIn', () => {
  it('names the tag of a name-rev name, whatever path from it follows', () => {
    assert.equal(parseFirstIn('v1.2~3\n'), 'v1.2');
    assert.equal(parseFirstIn('v1.2^2~5\n'), 'v1.2');
    assert.equal(parseFirstIn('v1.2^0\n'), 'v1.2');
    assert.equal(parseFirstIn('v1.2\n'), 'v1.2');
  });

  it('keeps dashes and slashes of the tag name', () => {
    assert.equal(parseFirstIn('zephyr-v3.7.0-rc1~12^2~3\n'), 'zephyr-v3.7.0-rc1');
    assert.equal(parseFirstIn('release/2026-01~1\n'), 'release/2026-01');
  });

  it('says no tag holds the commit for "undefined" and for nothing', () => {
    assert.equal(parseFirstIn('undefined\n'), null);
    assert.equal(parseFirstIn(''), null);
  });
});

describe('parseAfter', () => {
  it('splits the tag from the count and the hash', () => {
    assert.deepEqual(parseAfter('v0.1.0-2-g63f6af0\n'), { tag: 'v0.1.0', commits: 2 });
  });

  it('keeps tag names that themselves look like describe output', () => {
    assert.deepEqual(parseAfter('zephyr-v3.7.0-rc1-120-gabc1234\n'), { tag: 'zephyr-v3.7.0-rc1', commits: 120 });
    assert.deepEqual(parseAfter('build-4-gdeadbee-7-g0123456\n'), { tag: 'build-4-gdeadbee', commits: 7 });
  });

  it('gives nothing for output that is not --long describe output', () => {
    assert.equal(parseAfter(''), undefined);
    assert.equal(parseAfter('v1.0\n'), undefined);
  });
});

describe('parseOn', () => {
  const refs = [
    ref('refs/heads/zeta'),
    ref('refs/heads/main'),
    ref('refs/heads/alpha'),
    ref('refs/remotes/origin/main'),
    ref('refs/remotes/origin/alpha'),
    ref('refs/tags/v1'),
  ];
  const out = (...names: string[]) => `${names.join('\n')}\n`;

  it('lists the current branch, then local branches, then remote-tracking ones, by name', () => {
    const on = parseOn(out('refs/remotes/origin/alpha', 'refs/heads/zeta', 'refs/heads/main'), snapshot(refs), none);
    assert.deepEqual(
      on.refs.map((r) => r.short),
      ['main', 'zeta', 'origin/alpha'],
    );
    assert.equal(on.more, 0);
  });

  it(`names at most three and counts the rest`, () => {
    const all = refs.filter((r) => r.kind !== 'tag').map((r) => r.name);
    const on = parseOn(out(...all), snapshot(refs), none);
    assert.deepEqual(
      on.refs.map((r) => r.short),
      ['main', 'alpha', 'zeta'],
    );
    assert.equal(on.more, 2);
    assert.equal(on.hidden, 0);
  });

  it('leaves out branches whose badges are hidden and counts them apart', () => {
    const hidden = new Set(['refs/heads/zeta', 'refs/remotes/origin/alpha']);
    const on = parseOn(out('refs/heads/zeta', 'refs/remotes/origin/alpha', 'refs/heads/main'), snapshot(refs), hidden);
    assert.deepEqual(
      on.refs.map((r) => r.short),
      ['main'],
    );
    assert.deepEqual([on.more, on.hidden], [0, 2]);
  });

  it('leaves out refs the snapshot lacks, as symbolic origin/HEAD', () => {
    const on = parseOn(out('refs/remotes/origin/HEAD'), snapshot(refs), none);
    assert.deepEqual(on, { refs: [], more: 0, hidden: 0 });
  });

  it('puts no branch first when HEAD is detached', () => {
    const on = parseOn(out('refs/remotes/origin/main', 'refs/heads/main'), snapshot(refs, undefined), none);
    assert.deepEqual(
      on.refs.map((r) => r.short),
      ['main', 'origin/main'],
    );
  });
});

describe('whereAsk', () => {
  const at = h('c');
  const refs = [
    ref('refs/heads/main', at),
    ref('refs/tags/v1', h('b')),
    ref('refs/tags/v2-rc1', h('d')),
    ref('refs/tags/v2', at),
  ];

  it('asks both tag lines for an untagged commit, leaving out hidden tags', () => {
    const ask = whereAsk(snapshot(refs), new Set(['refs/tags/v2-rc1']), h('e'));
    assert.deepEqual(ask, { hidden: ['v2-rc1'], own: [], firstIn: true, after: true });
  });

  it('asks no First in for a commit carrying a shown tag, and After past its own tags', () => {
    assert.deepEqual(whereAsk(snapshot(refs), none, at), {
      hidden: [],
      own: ['v2'],
      firstIn: false,
      after: true,
    });
  });

  it('asks First in for a commit whose only tag is hidden', () => {
    const ask = whereAsk(snapshot(refs), new Set(['refs/tags/v2']), at);
    assert.equal(ask.firstIn, true);
  });

  it('asks no tag line when every tag is hidden or there is none', () => {
    const hidden = new Set(['refs/tags/v1', 'refs/tags/v2-rc1', 'refs/tags/v2']);
    assert.deepEqual(
      [whereAsk(snapshot(refs), hidden, h('e')).firstIn, whereAsk(snapshot(refs), hidden, h('e')).after],
      [false, false],
    );
    const plain = whereAsk(snapshot([ref('refs/heads/main')]), none, h('e'));
    assert.deepEqual([plain.firstIn, plain.after], [false, false]);
  });

  it('asks no After when the only shown tag is on the commit', () => {
    const ask = whereAsk(snapshot([ref('refs/tags/v1', at)]), none, at);
    assert.deepEqual([ask.firstIn, ask.after], [false, false]);
  });
});

describe('readWhere', () => {
  const dir = tempDir('where');
  let n = 0;
  const run = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_COMMITTER_DATE: `${1_700_000_000 + ++n * 60} +0000` },
    }).trim();
  const c: string[] = [];
  const unlimited = {};

  before(() => {
    run('init', '-q', '-b', 'main');
    run('config', 'user.name', 'T');
    run('config', 'user.email', 't@example.com');
    for (let i = 1; i <= 5; i++) {
      run('commit', '-q', '--allow-empty', '-m', `c${i}`);
      c[i] = run('rev-parse', 'HEAD');
    }
    run('tag', 'v0.1.0', c[1]!);
    run('tag', '-a', '-m', 'rc', 'v0.2.0-rc1', c[3]!);
    run('tag', '-a', '-m', 'release', 'v0.2.0', c[5]!);
    run('branch', 'topic', c[3]!);
    run('update-ref', 'refs/remotes/origin/main', c[4]!);
  });
  const read = async (hash: string, hidden: Set<string> = none, limits: GitLimits = unlimited) =>
    readWhere('git', dir, hash, await readRefs('git', dir), hidden, limits);

  it('says which branches hold an untagged commit, the first tag holding it and the tag before it', async () => {
    const where = await read(c[2]!);
    assert.deepEqual(
      where.on?.refs.map((r) => r.short),
      ['main', 'topic', 'origin/main'],
    );
    assert.equal(where.firstIn, 'v0.2.0-rc1');
    assert.deepEqual(where.after, { tag: 'v0.1.0', commits: 1 });
  });

  it('names no tag the rules hide', async () => {
    const where = await read(c[4]!, new Set(['refs/tags/v0.2.0-rc1']));
    assert.equal(where.firstIn, 'v0.2.0');
    assert.deepEqual(where.after, { tag: 'v0.1.0', commits: 3 });
  });

  it('gives a tagged commit no First in, and After the tag before its own', async () => {
    const where = await read(c[5]!);
    assert.equal('firstIn' in where, false);
    assert.deepEqual(where.after, { tag: 'v0.2.0-rc1', commits: 2 });
  });

  it('says when no tag holds the commit yet, and gives no After before the first tag', async () => {
    run('commit', '-q', '--allow-empty', '-m', 'c6');
    const where = await read(run('rev-parse', 'HEAD'));
    assert.equal(where.firstIn, null);
    run('reset', '-q', '--hard', c[5]!);
    assert.equal('after' in (await read(c[1]!)), false);
  });

  it('leaves out every line whose git is stopped', async () => {
    assert.deepEqual(await read(c[2]!, none, { signal: AbortSignal.abort() }), {});
  });
});
