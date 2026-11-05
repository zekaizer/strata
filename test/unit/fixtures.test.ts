import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { RepoBuilder } from '../fixtures/builder.ts';
import { scenarios, type ScenarioName } from '../fixtures/scenarios.ts';

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const count = (dir: string, ...args: string[]) => Number(git(dir, 'rev-list', '--all', '--count', ...args));

describe('fixture repositories', () => {
  let root: string;
  const repos = {} as Record<ScenarioName, string>;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'strata-fx-'));
    for (const [name, make] of Object.entries(scenarios)) {
      repos[name as ScenarioName] = join(root, name);
      make().write(repos[name as ScenarioName]);
    }
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('produces identical object ids on every run', () => {
    const again = join(root, 'branchy-again');
    scenarios.branchy().write(again);
    assert.equal(git(again, 'rev-parse', 'HEAD'), git(repos.branchy, 'rev-parse', 'HEAD'));
  });

  it('leaves a clean working tree on main and no scratch refs', () => {
    for (const dir of Object.values(repos)) {
      assert.equal(git(dir, 'status', '--porcelain'), '');
      assert.equal(git(dir, 'symbolic-ref', 'HEAD'), 'refs/heads/main');
      assert.equal(git(dir, 'for-each-ref', 'refs/strata-fixture'), '');
      git(dir, 'fsck', '--strict', '--no-progress');
    }
  });

  it('linear: 30 commits, no merges', () => {
    assert.equal(count(repos.linear), 30);
    assert.equal(count(repos.linear, '--merges'), 0);
  });

  it('branchy: merges, an unmerged branch and a criss-cross', () => {
    assert.ok(count(repos.branchy, '--merges') >= 5);
    assert.equal(git(repos.branchy, 'branch', '--no-merged', 'main'), 'wip/experiment');
    const x = git(repos.branchy, 'rev-parse', 'cross/x');
    const y = git(repos.branchy, 'rev-parse', 'cross/y');
    assert.equal(git(repos.branchy, 'merge-base', '--all', x, y).split('\n').length, 2);
  });

  it('stashes: two on one base, one on HEAD, a displaced autostash, one off every branch', () => {
    const d = repos.stashes;
    assert.deepEqual(git(d, 'stash', 'list', '--format=%gs').split('\n'), [
      'autostash',
      `WIP on main: ${git(d, 'log', '-1', '--format=%h %s', 'main')}`,
      'On feature/search: half-done ranking UI',
      'On feature/search: try a regex ranking',
      'On old-topic: abandoned spike',
    ]);
    assert.equal(git(d, 'rev-parse', 'stash@{2}^'), git(d, 'rev-parse', 'feature/search'));
    assert.equal(git(d, 'rev-parse', 'stash@{3}^'), git(d, 'rev-parse', 'feature/search'));
    assert.equal(git(d, 'rev-parse', 'stash@{1}^'), git(d, 'rev-parse', 'HEAD'));
    assert.equal(git(d, 'log', '-1', '--format=%s', 'stash@{0}'), 'On wip/experiment: autostash');
    assert.equal(git(d, 'branch', '--all', '--contains', 'stash@{0}^'), '');
    assert.equal(git(d, 'branch', '--all', '--contains', 'stash@{4}^'), '');
    assert.equal(git(d, 'ls-tree', '-r', '--name-only', 'stash@{2}^3'), 'notes/ranking-ideas.md');
  });

  it('octopus: a 4-parent and a 5-parent merge', () => {
    const parents = git(repos.octopus, 'rev-list', '--all', '--min-parents=3', '--parents')
      .split('\n')
      .map((l) => l.split(' ').length - 1)
      .sort();
    assert.deepEqual(parents, [4, 5]);
  });

  it('multi-root: three root commits, one unmerged', () => {
    assert.equal(count(repos['multi-root'], '--max-parents=0'), 3);
    assert.equal(Number(git(repos['multi-root'], 'rev-list', '--count', '--max-parents=0', 'main')), 2);
  });

  it('refs: annotated and lightweight tags, remotes, ahead/behind', () => {
    const d = repos.refs;
    assert.equal(git(d, 'cat-file', '-t', 'v0.1.0'), 'tag');
    assert.equal(git(d, 'cat-file', '-t', 'lightweight-tag'), 'commit');
    assert.deepEqual(git(d, 'for-each-ref', '--format=%(refname)', 'refs/remotes').split('\n').sort(), [
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/develop',
      'refs/remotes/origin/main',
      'refs/remotes/origin/release/0.2',
      'refs/remotes/upstream/main',
    ]);
    assert.deepEqual(git(d, 'remote').split('\n').sort(), ['origin', 'upstream']);
    assert.equal(git(d, 'rev-parse', '--symbolic-full-name', 'main@{upstream}'), 'refs/remotes/origin/main');
    assert.equal(git(d, 'rev-list', '--left-right', '--count', 'main...origin/main'), '2\t0');
    assert.equal(git(d, 'rev-list', '--left-right', '--count', 'develop...origin/develop'), '1\t0');
  });

  it('clock-skew: a child older than its parent', () => {
    const lines = git(repos['clock-skew'], 'log', '--all', '--format=%H %ct %P').split('\n');
    const time = new Map(lines.map((l) => l.split(' ')).map(([h, t]) => [h!, Number(t)]));
    const skewed = lines.some((l) => {
      const [, t, ...ps] = l.split(' ');
      return ps.some((p) => time.get(p)! > Number(t));
    });
    assert.ok(skewed);
  });

  it('large: requested size with octopus merges and extra roots', () => {
    assert.equal(count(repos.large), 5000);
    assert.ok(count(repos.large, '--min-parents=3') > 0);
    assert.ok(count(repos.large, '--max-parents=0') > 1);
  });

  it('rejects unknown branches', () => {
    assert.throws(() => new RepoBuilder().tip('nope'), /unknown branch/);
  });
});
