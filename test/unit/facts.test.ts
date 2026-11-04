import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { readCommit, readOverlap, readResetFacts, readUnmergedCommits } from '../../src/git/facts.ts';
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
});
