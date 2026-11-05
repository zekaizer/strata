import * as assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readDiscardedByAbort } from '../../src/git/facts.ts';
import { readAbortTarget, readOperationState, readWorktree } from '../../src/git/state.ts';
import { createStash } from '../../src/git/stash.ts';
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

  /** Edits made while stopped: other.txt unstaged, new.txt added (staged), next to f.txt's conflict. */
  const editWhileStopped = (d: string) => {
    writeFileSync(join(d, 'other.txt'), 'edited\n');
    writeFileSync(join(d, 'new.txt'), 'new\n');
    run(d, 'add', 'new.txt');
  };
  const state = async (d: string) => {
    const s = await readOperationState('git', d);
    assert.ok(s);
    return s;
  };

  it('names the changes Abort would discard: a rebase all of them, a merge or pick only staged ones', async () => {
    const r = repo();
    run(r, 'checkout', '--quiet', 'topic');
    stop(r, 'rebase', 'main');
    editWhileStopped(r);
    assert.deepEqual(await readDiscardedByAbort('git', r, await state(r)), ['new.txt', 'other.txt']);
    run(r, 'rebase', '--abort');
    assert.equal(readFileSync(join(r, 'other.txt'), 'utf8'), 'o\n', 'git discarded the unstaged edit');
    assert.equal(existsSync(join(r, 'new.txt')), false, 'git discarded the added file');

    const m = repo();
    stop(m, 'merge', 'topic');
    editWhileStopped(m);
    assert.equal(run(m, 'diff', '--cached', '--name-only', '--', 'g.txt'), 'g.txt', 'the merge staged g.txt');
    assert.deepEqual(await readDiscardedByAbort('git', m, await state(m)), ['new.txt']);
    run(m, 'merge', '--abort');
    assert.equal(readFileSync(join(m, 'other.txt'), 'utf8'), 'edited\n', 'git kept the unstaged edit');
    assert.equal(existsSync(join(m, 'new.txt')), false);

    const c = repo();
    stop(c, 'cherry-pick', 'topic~1');
    assert.deepEqual(await readDiscardedByAbort('git', c, await state(c)), [], 'nothing of the user is at stake');
    editWhileStopped(c);
    assert.deepEqual(await readDiscardedByAbort('git', c, await state(c)), ['new.txt']);
  });

  it('stashes changes next to unmerged files, which git stash push refuses, leaving them in place', async () => {
    const d = repo();
    run(d, 'checkout', '--quiet', 'topic');
    stop(d, 'rebase', 'main');
    editWhileStopped(d);
    const status = run(d, 'status', '--porcelain');
    const stash = await createStash('git', d, ['new.txt', 'other.txt'], 'On topic: kept');
    assert.equal(run(d, 'status', '--porcelain'), status, 'index and work tree untouched');
    run(d, 'stash', 'store', '--message', 'On topic: kept', stash);
    assert.equal(run(d, 'stash', 'list', '--format=%gs'), 'On topic: kept');
    assert.equal(run(d, 'stash', 'show', '--name-only', 'stash@{0}'), 'new.txt\nother.txt');
    run(d, 'rebase', '--abort');
    run(d, 'stash', 'apply', '--index', '--quiet');
    assert.equal(run(d, 'status', '--porcelain'), 'A  new.txt\n M other.txt');
    assert.equal(readFileSync(join(d, 'other.txt'), 'utf8'), 'edited\n');
  });

  it('reads where Abort goes, as git does: not ORIG_HEAD, and for a sequence its start', async () => {
    const r = repo();
    run(r, 'checkout', '--quiet', 'topic');
    stop(r, 'rebase', 'main');
    run(r, 'update-ref', 'ORIG_HEAD', 'main');
    assert.equal(await readAbortTarget('git', r, 'rebase'), run(r, 'rev-parse', 'topic'));

    const m = repo();
    stop(m, 'merge', 'topic');
    assert.equal(await readAbortTarget('git', m, 'merge'), run(m, 'rev-parse', 'main'));

    const one = repo();
    stop(one, 'cherry-pick', 'topic~1');
    assert.equal(await readAbortTarget('git', one, 'cherryPick'), run(one, 'rev-parse', 'main'));

    const seq = repo();
    const start = run(seq, 'rev-parse', 'main');
    stop(seq, 'cherry-pick', 'topic', 'topic~1');
    assert.notEqual(run(seq, 'rev-parse', 'HEAD'), start, 'the first was picked');
    assert.equal(await readAbortTarget('git', seq, 'cherryPick'), start);
    const moved = run(seq, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'moved');
    run(seq, 'update-ref', 'HEAD', moved);
    assert.equal(await readAbortTarget('git', seq, 'cherryPick'), moved);
    spawnSync('git', ['cherry-pick', '--abort'], { cwd: seq, env });
    assert.equal(run(seq, 'rev-parse', 'HEAD'), moved, 'git leaves a moved HEAD alone');
  });
});
