import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import {
  countCommits,
  isAncestor,
  readCommit,
  readConfigBool,
  readHead,
  readMergeBase,
  readOverlap,
  readResetFacts,
  readStashIndex,
  readStashTop,
  readUnmerged,
  readUnmergedCommits,
  readUpstream,
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
      f.dropped.map((c) => c.subject),
      ['four', 'three', 'two'],
    );
    assert.equal(f.dropped[0]!.short, run(dir, 'rev-parse', '--short', 'main'));
    assert.equal(f.gained, 0);
    assert.equal(f.upstream, 'origin/main');
    assert.equal(f.onUpstream, 1, '"two" is on origin/main');
    assert.equal(f.unreachable, 1, '"three" is on keep, "two" on origin/main; only "four" would be lost');
    assert.equal(f.dirtyFiles, 2);
  });

  it('counts what a reset to another line gains', async () => {
    const f = await readResetFacts('git', dir, run(dir, 'rev-parse', 'topic'), 0);
    assert.equal(f.gained, 2);
    assert.equal(f.dropped.length, 3);
  });

  it("lists a branch's commits that no other ref has", async () => {
    assert.deepEqual(
      (await readUnmergedCommits('git', dir, 'topic')).map((c) => c.subject),
      ['topic two', 'topic one'],
    );
    assert.deepEqual(await readUnmergedCommits('git', dir, 'keep'), []);
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

  it("reads a branch's upstream, and none for a branch without one", async () => {
    assert.deepEqual(await readUpstream('git', dir, 'main'), {
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
    assert.equal(await readStashIndex('git', dir, top), 0);
    writeFileSync(join(dir, 'a.txt'), 'second\n');
    run(dir, 'stash', 'push', '--quiet');
    assert.equal(await readStashIndex('git', dir, top), 1, 'renumbered by the newer stash');
    run(dir, 'stash', 'drop', '--quiet', 'stash@{0}');
    assert.equal(await readStashIndex('git', dir, 'f'.repeat(40)), undefined);
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
});
