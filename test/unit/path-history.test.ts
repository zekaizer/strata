import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import type { Commit } from '../../src/core/commit.ts';
import { initialLaneState, layoutPage } from '../../src/core/layout.ts';
import { LOG_FORMAT } from '../../src/core/log-parser.ts';
import { parsePathFilter, type PathFilter } from '../../src/core/path-filter.ts';
import type { FindQuery } from '../../src/core/find.ts';
import { findCommits, locateCommit } from '../../src/git/find.ts';
import { LogReader, type LogOptions } from '../../src/git/log-reader.ts';
import { changingCommits, isPartialClone, isTracked, readPathOrigin } from '../../src/git/path-history.ts';
import { RepoBuilder } from '../fixtures/builder.ts';
import { scenarios } from '../fixtures/scenarios.ts';
import { git, tempDir } from './helpers.ts';

const SESSION = 'src/auth/session.ts';

/** Commits of the paths fixture that change src/auth/session.ts or src/session.ts, by subject. */
const CHANGES_SESSION = [
  'Clear session on logout in every tab',
  'Create sessions from SSO assertions',
  "Merge branch 'feature/refresh-token'",
  'Add jitter to refresh timer',
  'Refresh tokens before they expire',
  'Use seconds for session TTL',
  'Move session handling under src/auth',
];
/** Tips of the fixture's branches and remote-tracking branches that leave the file alone. */
const UNCHANGED_TIPS = ['Bump dependencies', 'Board keyboard navigation', 'SAML response parsing'];

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

const filter = (...paths: string[]): PathFilter => parsePathFilter({ paths })!;

/** Lanes left waiting for a commit once all of `commits` are laid out. */
const openLanes = (commits: readonly Commit[]) =>
  layoutPage(initialLaneState(), commits).state.lanes.filter((l) => l !== null);

describe('path history', () => {
  const root = tempDir('path-history');
  const dir = join(root, 'paths');
  const sha = (rev: string) => git(dir, 'rev-parse', rev);
  before(() => {
    scenarios.paths().write(dir);
  });

  it('lists the commits that change a file and the branch tips, every lane closing', async () => {
    const commits = await readAll({ git: 'git', cwd: dir, paths: [SESSION] });
    const subjects = commits.map((c) => c.subject);
    // The cherry-pick and the original fix are both there.
    assert.equal(subjects.filter((s) => s === CHANGES_SESSION[0]).length, 2);
    assert.deepEqual(new Set(subjects), new Set([...CHANGES_SESSION, ...UNCHANGED_TIPS]));
    assert.ok(!subjects.includes("Merge branch 'fix/logout'"), 'a merge that takes one side unchanged is left out');
    assert.deepEqual(openLanes(commits), []);
  });

  it('lists the commits that change anything in a folder', async () => {
    const commits = await readAll({ git: 'git', cwd: dir, paths: ['src/auth/'] });
    const subjects = new Set(commits.map((c) => c.subject));
    assert.ok(subjects.has('SSO provider config'));
    assert.ok(subjects.has('Move session handling under src/auth'));
    assert.ok(!subjects.has('Initial project layout'));
    assert.deepEqual(openLanes(commits), []);
  });

  it('shows the merge that brought a change into the first-parent line', async () => {
    const commits = await readAll({ git: 'git', cwd: dir, paths: [SESSION], firstParent: true });
    const subjects = commits.map((c) => c.subject);
    assert.ok(subjects.includes("Merge branch 'fix/logout'"));
    assert.ok(commits.every((c) => c.parents.length <= 1));
    assert.deepEqual(openLanes(commits), []);
  });

  it('keeps only the selected refs as start points and tips', async () => {
    const commits = await readAll({ git: 'git', cwd: dir, paths: [SESSION], refs: ['refs/heads/release/2.x'] });
    assert.equal(commits[0]?.hash, sha('release/2.x'));
    const subjects = commits.map((c) => c.subject);
    for (const s of [...UNCHANGED_TIPS, 'Create sessions from SSO assertions']) assert.ok(!subjects.includes(s), s);
    assert.deepEqual(openLanes(commits), []);
  });

  it('finds and locates commits within the path history only', async () => {
    const hits: string[] = [];
    await findCommits(
      {
        git: 'git',
        cwd: dir,
        paths: [SESSION],
        query: { text: 'session', author: undefined, hashPrefix: undefined } satisfies FindQuery,
        cap: 100,
        signal: new AbortController().signal,
      },
      (b) => hits.push(...b.hits.map((h) => h.subject)),
    );
    assert.ok(hits.includes('Use seconds for session TTL'));
    assert.ok(!hits.includes('Persist sessions in local storage'), 'changes only src/session.ts');
    const shown = await readAll({ git: 'git', cwd: dir, paths: [SESSION] });
    const moved = shown.findIndex((c) => c.subject === 'Move session handling under src/auth');
    const opts = { git: 'git', cwd: dir, paths: [SESSION], signal: new AbortController().signal };
    assert.equal((await locateCommit({ ...opts, hash: shown[moved]!.hash })).position, moved);
    const outside = git(dir, 'log', '--format=%H', '--grep=Request timeouts', 'main');
    assert.equal((await locateCommit({ ...opts, hash: outside })).position, undefined);
  });

  it("keeps another worktree's detached HEAD when it changes the path", async () => {
    const commit = (tree: string) =>
      git(
        dir,
        '-c',
        'user.name=Ada',
        '-c',
        'user.email=a@b',
        'commit-tree',
        `${tree}^{tree}`,
        '-p',
        'release/2.x',
        '-m',
        tree,
      );
    const changes = commit('feature/sso');
    const leaves = commit('release/2.x');
    const hashes = (await readAll({ git: 'git', cwd: dir, paths: [SESSION], heads: [changes, leaves] })).map(
      (c) => c.hash,
    );
    assert.ok(hashes.includes(changes));
    assert.ok(!hashes.includes(leaves));
  });

  it('takes file names literally', async () => {
    const lit = join(root, 'literal');
    const b = new RepoBuilder();
    b.commit('main', 'add files', { files: { ':magic': '1\n', 'a*b': '1\n', axb: '1\n' } });
    b.commit('main', 'change axb', { files: { axb: '2\n' } });
    b.commit('main', 'change a*b', { files: { 'a*b': '2\n' } });
    b.commit('main', 'change :magic', { files: { ':magic': '2\n' } });
    b.write(lit);
    const subjects = async (p: string) =>
      (await readAll({ git: 'git', cwd: lit, paths: [p] })).map((c) => c.subject).filter((s) => s !== 'change :magic');
    assert.deepEqual(await subjects('a*b'), ['change a*b', 'add files']);
    const magic = await readAll({ git: 'git', cwd: lit, paths: [':magic'] });
    assert.deepEqual(
      magic.map((c) => c.subject),
      ['change :magic', 'add files'],
    );
  });

  it('rejects paths that are not repository-relative', async () => {
    for (const p of ['../x', '/etc/passwd', '']) {
      const r = new LogReader({ git: 'git', cwd: dir, paths: [p] });
      await assert.rejects(r.next(1), /invalid path/);
      r.dispose();
    }
  });

  it('tells which tips change the file, as the history does', async () => {
    const tips = ['main', 'origin/main', 'feature/sso', 'origin/feature/sso', 'release/2.x', 'feature/refresh-token'];
    const changing = await changingCommits('git', dir, tips.map(sha), filter(SESSION));
    assert.deepEqual(
      tips.filter((t) => changing.has(sha(t))),
      ['origin/feature/sso', 'release/2.x', 'feature/refresh-token'],
    );
    const merge = git(dir, 'log', '--merges', '--format=%H', '--grep=refresh-token', 'main');
    assert.ok((await changingCommits('git', dir, [merge], filter(SESSION))).has(merge), 'a hand-resolved merge');
    // A merge that took the other side's change leaves its first parent's version behind.
    const taken = git(dir, 'log', '--merges', '--format=%H', '--grep=fix/logout', 'main');
    assert.equal((await changingCommits('git', dir, [taken], filter(SESSION))).has(taken), false);
    assert.equal((await changingCommits('git', dir, [taken], filter(SESSION), true)).has(taken), true);
  });

  it('finds the rename a file history starts with', async () => {
    const moved = git(dir, 'log', '--format=%H', '--grep=Move session', 'main');
    assert.deepEqual(await readPathOrigin('git', dir, moved, filter(SESSION), false), {
      kind: 'renamed',
      hash: moved,
      from: 'src/session.ts',
      to: SESSION,
    });
    const first = git(dir, 'rev-list', '--max-parents=0', 'main');
    assert.deepEqual(await readPathOrigin('git', dir, first, filter(SESSION, 'src/session.ts'), false), {
      kind: 'added',
      hash: first,
      exactOnly: false,
    });
    const folder = await readPathOrigin('git', dir, moved, filter('src/auth/'), false);
    assert.equal(folder.kind === 'renamed' && folder.from, 'src/');
  });

  it('finds renames without downloading contents in a partial clone', async () => {
    git(dir, 'config', 'uploadpack.allowFilter', 'true');
    const clone = join(root, 'partial');
    git(root, 'clone', '--quiet', '--no-local', '--filter=blob:none', '--no-checkout', `file://${dir}`, clone);
    // Any download now fails.
    git(clone, 'remote', 'set-url', 'origin', join(root, 'gone'));
    assert.equal(await isPartialClone('git', clone), true);
    assert.equal(await isPartialClone('git', dir), false);
    const moved = git(clone, 'log', '--format=%H', '--grep=Move session', 'origin/main');
    assert.deepEqual(await readPathOrigin('git', clone, moved, filter(SESSION), true), {
      kind: 'renamed',
      hash: moved,
      from: 'src/session.ts',
      to: SESSION,
    });
  });

  it('tells a path the index has from one it does not', async () => {
    assert.equal(await isTracked('git', dir, filter(SESSION)), true);
    assert.equal(await isTracked('git', dir, filter('nowhere.txt')), false);
  });
});

describe('partial pages', () => {
  const root = tempDir('partial-pages');

  it('returns what has arrived once the flush time passes', async () => {
    const dir = join(root, 'repo');
    scenarios.linear().write(dir);
    const log = (...args: string[]) =>
      execFileSync('git', ['log', '-z', `--format=${LOG_FORMAT}`, ...args], { cwd: dir });
    writeFileSync(join(root, 'first'), log('-1'));
    writeFileSync(join(root, 'rest'), log('--skip=1', '-2'));
    // A git that prints one record, then the next two a second later.
    const fake = join(root, 'slow-git');
    writeFileSync(fake, `#!/bin/sh\ncat "${join(root, 'first')}"\nsleep 1\ncat "${join(root, 'rest')}"\n`);
    chmodSync(fake, 0o755);
    const r = new LogReader({ git: fake, cwd: dir, refs: ['refs/heads/main'] });
    const started = performance.now();
    const first = await r.next(10, { flushAfterMs: 100 });
    const waited = performance.now() - started;
    assert.equal(first.commits.length, 1);
    assert.equal(first.done, false);
    assert.ok(waited < 900, `served after ${Math.round(waited)} ms`);
    const rest = await r.next(10);
    assert.equal(rest.commits.length, 2);
    assert.equal(rest.done, true);
    r.dispose();
  });
});
