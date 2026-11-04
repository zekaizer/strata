import * as assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readOperationState, readWorktree } from '../../src/git/state.ts';
import { tempDir } from './helpers.ts';

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'a',
  GIT_AUTHOR_EMAIL: 'a@example.com',
  GIT_COMMITTER_NAME: 'a',
  GIT_COMMITTER_EMAIL: 'a@example.com',
  GIT_EDITOR: 'true',
};
const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
/** Runs a git command expected to stop with conflicts. */
const stop = (cwd: string, ...args: string[]) => {
  assert.notEqual(spawnSync('git', args, { cwd, env }).status, 0, `${args.join(' ')} should stop`);
};

describe('repository state', () => {
  const root = tempDir('state');
  let n = 0;
  /** main and topic both change line 1 of f.txt, topic in two commits. */
  const repo = () => {
    const d = join(root, `r${n++}`);
    mkdirSync(d);
    run(d, 'init', '--quiet', '-b', 'main');
    writeFileSync(join(d, 'f.txt'), 'base\n');
    writeFileSync(join(d, 'other.txt'), 'o\n');
    run(d, 'add', '.');
    run(d, 'commit', '--quiet', '-m', 'base');
    run(d, 'checkout', '--quiet', '-b', 'topic');
    writeFileSync(join(d, 'f.txt'), 'topic\n');
    run(d, 'commit', '--quiet', '-am', 'topic 1');
    writeFileSync(join(d, 'g.txt'), 'g\n');
    run(d, 'add', '.');
    run(d, 'commit', '--quiet', '-m', 'topic 2');
    run(d, 'checkout', '--quiet', 'main');
    writeFileSync(join(d, 'f.txt'), 'main\n');
    run(d, 'commit', '--quiet', '-am', 'main 1');
    return d;
  };

  it('is idle in a clean repository', async () => {
    const d = repo();
    assert.equal(await readOperationState('git', d), undefined);
    assert.deepEqual(await readWorktree('git', d), { paths: [], deleted: [], staged: 0, unstaged: 0, submodules: 0 });
  });

  it('counts staged and unstaged changes but not untracked files', async () => {
    const d = repo();
    writeFileSync(join(d, 'f.txt'), 'edited\n');
    writeFileSync(join(d, 'other.txt'), 'staged\n');
    run(d, 'add', 'other.txt');
    writeFileSync(join(d, 'untracked.txt'), 'u\n');
    const w = await readWorktree('git', d);
    assert.deepEqual([...w.paths].sort(), ['f.txt', 'other.txt']);
    assert.equal(w.staged, 1);
    assert.equal(w.unstaged, 1);
  });

  it('tells deletions from the index (git rm) from deleted files git still tracks', async () => {
    const d = repo();
    run(d, 'rm', '--quiet', 'f.txt');
    const w = await readWorktree('git', d);
    assert.deepEqual(w.deleted, ['f.txt']);
    run(d, 'reset', '--quiet', '--', 'f.txt');
    assert.deepEqual((await readWorktree('git', d)).deleted, []);
  });

  it('reads a rebase stopped at a conflict, with its step, target and autostash', async () => {
    const d = repo();
    writeFileSync(join(d, 'other.txt'), 'dirty\n');
    run(d, 'checkout', '--quiet', 'topic');
    stop(d, 'rebase', '--autostash', 'main');
    const s = await readOperationState('git', d);
    assert.ok(s);
    assert.equal(s.kind, 'rebase');
    assert.equal(s.branch, 'topic');
    assert.equal(s.onto, run(d, 'rev-parse', 'main'));
    assert.deepEqual(s.step, { current: 1, total: 2 });
    assert.equal(s.applying, run(d, 'rev-parse', 'topic~1'));
    assert.deepEqual(s.conflicts, ['f.txt']);
    assert.equal(s.conflictCount, 1);
    assert.equal(s.autostash, true);
  });

  it('reads a stopped merge, cherry-pick and revert', async () => {
    const m = repo();
    stop(m, 'merge', 'topic');
    const ms = await readOperationState('git', m);
    assert.equal(ms?.kind, 'merge');
    assert.equal(ms.branch, 'main');
    assert.equal(ms.applying, run(m, 'rev-parse', 'topic'));
    assert.deepEqual(ms.conflicts, ['f.txt']);

    const c = repo();
    stop(c, 'cherry-pick', 'topic~1');
    const cs = await readOperationState('git', c);
    assert.equal(cs?.kind, 'cherryPick');
    assert.equal(cs.applying, run(c, 'rev-parse', 'topic~1'));
    assert.equal(cs.autostash, false);

    assert.equal(cs.empty, false, 'conflicts to resolve, not empty');

    const e = repo();
    run(e, 'checkout', '--quiet', 'topic');
    stop(e, 'cherry-pick', 'topic~1');
    const es = await readOperationState('git', e);
    assert.equal(es?.kind, 'cherryPick');
    assert.equal(es.conflictCount, 0);
    assert.equal(es.empty, true, 'its change is already on topic');

    const r = repo();
    run(r, 'checkout', '--quiet', 'topic');
    writeFileSync(join(r, 'f.txt'), 'later\n');
    run(r, 'commit', '--quiet', '-am', 'later');
    stop(r, 'revert', 'topic~2');
    const rs = await readOperationState('git', r);
    assert.equal(rs?.kind, 'revert');
    assert.equal(rs.branch, 'topic');
  });
});
