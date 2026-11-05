import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import {
  countCommits,
  isShallow,
  isShallowEdge,
  isAncestor,
  readBranchConfig,
  readCommit,
  readConfigBool,
  readHead,
  readMergeBase,
  readMergeParents,
  readRebaseCounts,
  readOverlap,
  readResetFacts,
  readStash,
  readStashFilesHere,
  readStashFilesUntrackedHere,
  readStashTop,
  readUnmerged,
  readUnmergedCommits,
  readUntrackedAt,
  readUntrackedIn,
  readUpstream,
  readWorktreeBranches,
} from '../../src/git/facts.ts';
import { tempDir } from './helpers.ts';

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'a',
  GIT_AUTHOR_EMAIL: 'a@e',
  GIT_COMMITTER_NAME: 'a',
  GIT_COMMITTER_EMAIL: 'a@e',
};
const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
const commit = (cwd: string, file: string, subject: string) => {
  writeFileSync(join(cwd, file), `${subject}\n`);
  run(cwd, 'add', '.');
  run(cwd, 'commit', '--quiet', '-m', subject);
};

describe('confirmation facts', () => {
  const root = tempDir('facts');
  const origin = join(root, 'origin');
  const dir = join(root, 'clone');
  before(() => {
    mkdirSync(origin);
    run(origin, 'init', '--quiet', '-b', 'main');
    commit(origin, 'a.txt', 'one');
    commit(origin, 'a.txt', 'two');
    run(root, 'clone', '--quiet', origin, dir);
    commit(dir, 'a.txt', 'three');
    commit(dir, 'b.txt', 'four');
    run(dir, 'branch', 'keep', 'HEAD~1');
    run(dir, 'checkout', '--quiet', '-b', 'topic', 'main~3');
    commit(dir, 'c.txt', 'topic one');
    commit(dir, 'c.txt', 'topic two');
    run(dir, 'checkout', '--quiet', 'main');
  });

  it('lists the commits a reset drops, and which are on the upstream or nowhere else', async () => {
    const f = await readResetFacts('git', dir, run(dir, 'rev-parse', 'main~3'), 2);
    assert.equal(f.branch, 'main');
    assert.equal(f.target.subject, 'one');
    assert.deepEqual(
      f.dropped.newest.map((c) => c.subject),
      ['four', 'three', 'two'],
    );
    assert.equal(f.dropped.count, 3);
    assert.equal(f.dropped.newest[0]!.short, run(dir, 'rev-parse', '--short', 'main'));
    assert.equal(f.gained, 0);
    assert.equal(f.upstream, 'origin/main');
    assert.equal(f.onUpstream, 1, '"two" is on origin/main');
    assert.equal(f.unreachable, 1, '"three" is on keep, "two" on origin/main; only "four" would be lost');
    assert.equal(f.dirtyFiles, 2);
  });

  it('counts what a reset to another line gains', async () => {
    const f = await readResetFacts('git', dir, run(dir, 'rev-parse', 'topic'), 0);
    assert.equal(f.gained, 2);
    assert.equal(f.dropped.count, 3);
  });

  it("lists a branch's commits that no other ref has", async () => {
    const topic = await readUnmergedCommits('git', dir, 'topic');
    assert.deepEqual(
      topic.newest.map((c) => c.subject),
      ['topic two', 'topic one'],
    );
    assert.equal(topic.count, 2);
    assert.deepEqual(await readUnmergedCommits('git', dir, 'keep'), { newest: [], count: 0 });
  });

  it('counts every commit a reset or a branch deletion loses, beyond those it names', async () => {
    const many = join(root, 'many');
    mkdirSync(many);
    run(many, 'init', '--quiet', '-b', 'main');
    commit(many, 'a.txt', 'base');
    run(many, 'checkout', '--quiet', '-b', 'long');
    for (let i = 1; i <= 60; i++) run(many, 'commit', '--quiet', '--allow-empty', '-m', `long ${i}`);
    const unmerged = await readUnmergedCommits('git', many, 'long');
    assert.equal(unmerged.count, 60);
    assert.equal(unmerged.newest.length, 50);
    assert.equal(unmerged.newest[0]!.subject, 'long 60');
    const reset = await readResetFacts('git', many, 'main', 0);
    assert.equal(reset.dropped.count, 60);
    assert.equal(reset.dropped.newest.length, 50);
    assert.equal(reset.unreachable, 60);
  });

  it('finds dirty files a switch would have to touch', async () => {
    assert.deepEqual(await readOverlap('git', dir, run(dir, 'rev-parse', 'topic'), ['a.txt', 'c.txt', 'z.txt']), [
      'a.txt',
      'c.txt',
    ]);
  });

  it('names a commit by id, abbreviation and subject', async () => {
    assert.deepEqual(await readCommit('git', dir, 'topic'), {
      hash: run(dir, 'rev-parse', 'topic'),
      short: run(dir, 'rev-parse', '--short', 'topic'),
      subject: 'topic two',
    });
  });

  it("reads a merge's parents with the commits merged in relative to each, and none for other commits", async () => {
    const merge = run(dir, 'commit-tree', 'main^{tree}', '-p', 'main', '-p', 'topic', '-m', 'merged');
    assert.deepEqual(await readMergeParents('git', dir, merge), [
      { ...(await readCommit('git', dir, 'main')), mergedIn: 2 },
      { ...(await readCommit('git', dir, 'topic')), mergedIn: 3 },
    ]);
    assert.equal(await readMergeParents('git', dir, 'main'), undefined);
  });

  it("reads a branch's upstream, and none for a branch without one", async () => {
    assert.deepEqual(await readUpstream('git', dir, 'main'), {
      ref: 'refs/remotes/origin/main',
      name: 'origin/main',
      remote: 'origin',
      remoteBranch: 'main',
    });
    assert.equal(await readUpstream('git', dir, 'topic'), undefined);
  });

  it('counts commits and tells ancestors', async () => {
    assert.equal(await countCommits('git', dir, ['main', '--not', 'origin/main']), 2);
    assert.equal(await isAncestor('git', dir, 'origin/main', 'main'), true);
    assert.equal(await isAncestor('git', dir, 'topic', 'main'), false);
  });

  it('reads boolean git config, undefined when unset', async () => {
    assert.equal(await readConfigBool('git', dir, 'strata.test.flag'), undefined);
    run(dir, 'config', 'strata.test.flag', 'yes');
    assert.equal(await readConfigBool('git', dir, 'strata.test.flag'), true);
    run(dir, 'config', 'strata.test.flag', 'off');
    assert.equal(await readConfigBool('git', dir, 'strata.test.flag'), false);
    run(dir, 'config', '--unset', 'strata.test.flag');
  });

  it('lists unmerged paths and the newest stash', async () => {
    assert.deepEqual(await readUnmerged('git', dir), []);
    assert.equal(await readStashTop('git', dir), undefined);
    writeFileSync(join(dir, 'a.txt'), 'stashed\n');
    run(dir, 'stash', 'push', '--quiet');
    const top = run(dir, 'rev-parse', 'refs/stash');
    assert.equal(await readStashTop('git', dir), top);
    assert.deepEqual(await readStash('git', dir, top), {
      hash: top,
      index: 0,
      message: 'WIP on main: ' + run(dir, 'log', '-1', '--format=%h %s'),
    });
    writeFileSync(join(dir, 'a.txt'), 'second\n');
    run(dir, 'stash', 'push', '--quiet');
    assert.equal((await readStash('git', dir, top))?.index, 1, 'renumbered by the newer stash');
    run(dir, 'stash', 'drop', '--quiet', 'stash@{0}');
    assert.equal(await readStash('git', dir, 'f'.repeat(40)), undefined);
    run(dir, 'checkout', '--quiet', 'keep');
    writeFileSync(join(dir, 'a.txt'), 'other\n');
    run(dir, 'commit', '--quiet', '-am', 'other');
    assert.throws(() => run(dir, 'stash', 'pop'));
    assert.deepEqual(await readUnmerged('git', dir), ['a.txt']);
    run(dir, 'reset', '--quiet', '--hard', 'HEAD~1');
    run(dir, 'checkout', '--quiet', 'main');
    run(dir, 'stash', 'drop', '--quiet');
  });

  it('reads where HEAD is, and where two lines meet', async () => {
    assert.deepEqual(await readHead('git', dir), { branch: 'main', hash: run(dir, 'rev-parse', 'main') });
    run(dir, 'checkout', '--quiet', '--detach', 'keep');
    assert.deepEqual(await readHead('git', dir), { branch: undefined, hash: run(dir, 'rev-parse', 'keep') });
    run(dir, 'checkout', '--quiet', 'main');
    assert.equal(await readMergeBase('git', dir, 'main', 'topic'), run(dir, 'rev-parse', 'main~3'));
  });

  it("reads a branch's own configuration, not that of branches whose names extend it", async () => {
    run(dir, 'config', 'branch.topic.description', 'mine');
    run(dir, 'config', 'branch.topic.x.description', 'other');
    assert.deepEqual(await readBranchConfig('git', dir, 'topic'), [['branch.topic.description', 'mine']]);
    assert.deepEqual(await readBranchConfig('git', dir, 'main'), [
      ['branch.main.remote', 'origin'],
      ['branch.main.merge', 'refs/heads/main'],
    ]);
    run(dir, 'config', '--remove-section', 'branch.topic');
    run(dir, 'config', '--remove-section', 'branch.topic.x');
  });

  it('counts what a rebase replays, and which replayed commits are on the upstream', async () => {
    assert.deepEqual(await readRebaseCounts('git', dir, 'main~3', 'origin/main'), {
      replay: 3,
      merges: 0,
      onUpstream: 1,
    });
    assert.deepEqual(await readRebaseCounts('git', dir, 'main', undefined), { replay: 0, merges: 0, onUpstream: 0 });
    assert.equal(await isShallow('git', dir), false);
  });

  it('finds untracked files a hard reset to another line would overwrite', async () => {
    run(dir, 'checkout', '--quiet', 'topic');
    writeFileSync(join(dir, 'b.txt'), 'mine\n');
    assert.deepEqual(await readUntrackedAt('git', dir, 'main'), ['b.txt'], 'b.txt is tracked on main only');
    rmSync(join(dir, 'b.txt'));
    run(dir, 'checkout', '--quiet', 'main');
  });

  it('reads back the untracked files git named in the way, or none when it named one that is not', async () => {
    mkdirSync(join(dir, 'notes', 'old'), { recursive: true });
    for (const f of ['one.txt', 'notes/a.txt', 'notes/old/b.txt', 'notes/c.log', 'x*y.txt'])
      writeFileSync(join(dir, f), 'mine\n');
    run(dir, 'config', 'core.excludesFile', join(root, 'ignore'));
    writeFileSync(join(root, 'ignore'), '*.log\n');
    try {
      assert.deepEqual(await readUntrackedIn('git', dir, ['one.txt', 'notes', 'x*y.txt']), [
        'notes/a.txt',
        'notes/old/b.txt',
        'one.txt',
        'x*y.txt',
      ]);
      assert.equal(await readUntrackedIn('git', dir, ['one.txt', 'a']), undefined, 'a names no file');
      assert.equal(await readUntrackedIn('git', dir, ['a.txt']), undefined, 'tracked');
      assert.equal(await readUntrackedIn('git', dir, ['notes/c.log']), undefined, 'ignored: git overwrites it');
      assert.equal(await readUntrackedIn('git', dir, []), undefined);
    } finally {
      run(dir, 'config', '--unset', 'core.excludesFile');
      for (const f of ['one.txt', 'notes', 'x*y.txt']) rmSync(join(dir, f), { recursive: true });
    }
  });

  it("names the files of a stash's untracked part that exist here", async () => {
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    mkdirSync(join(dir, 'new'));
    for (const f of ['new/one.txt', 'two.txt']) writeFileSync(join(dir, f), 'stashed\n');
    run(dir, 'stash', 'push', '--quiet', '--include-untracked');
    const withUntracked = run(dir, 'rev-parse', 'refs/stash');
    writeFileSync(join(dir, 'a.txt'), 'changed again\n');
    run(dir, 'stash', 'push', '--quiet');
    const without = run(dir, 'rev-parse', 'refs/stash');
    try {
      assert.deepEqual(await readStashFilesHere('git', dir, withUntracked), []);
      writeFileSync(join(dir, 'two.txt'), 'mine\n');
      assert.deepEqual(await readStashFilesHere('git', dir, withUntracked), ['two.txt']);
      assert.deepEqual(await readStashFilesHere('git', dir, without), [], 'no untracked part');
      assert.deepEqual(await readStashFilesUntrackedHere('git', dir, withUntracked), ['two.txt']);
      run(dir, 'add', 'two.txt');
      assert.deepEqual(await readStashFilesUntrackedHere('git', dir, withUntracked), [], 'git tracks it here');
    } finally {
      run(dir, 'rm', '--quiet', '--cached', '--ignore-unmatch', 'two.txt');
      rmSync(join(dir, 'two.txt'));
      run(dir, 'stash', 'clear');
    }
  });

  it("tells a shallow clone's oldest commits, whose parents it lacks, from root commits", async () => {
    const shallow = join(root, 'shallow');
    run(root, 'clone', '--quiet', '--depth', '1', `file://${origin}`, shallow);
    const tip = run(shallow, 'rev-parse', 'HEAD');
    assert.equal(await isShallowEdge('git', shallow, tip), true);
    const linked = join(root, 'shallow worktree');
    run(shallow, 'worktree', 'add', '--quiet', '--detach', linked);
    try {
      assert.equal(await isShallowEdge('git', linked, tip), true, 'from a linked worktree too');
    } finally {
      run(shallow, 'worktree', 'remove', '--force', linked);
    }
    assert.equal(await isShallowEdge('git', dir, run(dir, 'rev-parse', 'main')), false, 'a full clone');
    assert.equal(await isShallowEdge('git', dir, run(dir, 'rev-list', '--max-parents=0', 'main')), false, 'a root');
    run(shallow, 'fetch', '--quiet', '--unshallow');
    assert.equal(await isShallowEdge('git', shallow, tip), false, 'its parent is here now');
  });

  it('names the other worktrees branches are checked out in', async () => {
    const other = join(root, 'other worktree');
    run(dir, 'worktree', 'add', '--quiet', other, 'topic');
    try {
      assert.deepEqual([...(await readWorktreeBranches('git', dir))], [['refs/heads/topic', other]]);
    } finally {
      run(dir, 'worktree', 'remove', '--force', other);
    }
    assert.deepEqual([...(await readWorktreeBranches('git', dir))], []);
  });
});
