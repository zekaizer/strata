import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { readCommitDetails } from '../../src/git/details.ts';
import { scenarios } from '../fixtures/scenarios.ts';
import { git, tempDir } from './helpers.ts';

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Grace Hopper',
  GIT_AUTHOR_EMAIL: 'grace@example.com',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'Committer Bot',
  GIT_COMMITTER_EMAIL: 'bot@example.com',
  GIT_COMMITTER_DATE: '1700000100 +0000',
};
const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' });

describe('readCommitDetails', () => {
  const root = tempDir('details');
  const dir = join(root, 'repo');
  before(() => {
    mkdirSync(dir);
    run(dir, 'init', '--quiet', '-b', 'main');
    writeFileSync(join(dir, 'keep.txt'), 'a\nb\nc\nd\ne\nf\n');
    writeFileSync(join(dir, 'old name.txt'), 'rename me\n'.repeat(20));
    writeFileSync(join(dir, 'gone.txt'), 'bye\n');
    run(dir, 'add', '.');
    run(dir, 'commit', '--quiet', '-m', 'root commit');
    writeFileSync(join(dir, 'keep.txt'), 'a\nb\nc\nd\ne\nchanged\n');
    run(dir, 'mv', 'old name.txt', 'new\tname.txt');
    rmSync(join(dir, 'gone.txt'));
    mkdirSync(join(dir, 'dir'));
    writeFileSync(join(dir, 'dir', 'ünïcode.txt'), 'new\n');
    run(dir, 'add', '-A');
    run(dir, 'commit', '--quiet', '-m', 'Change things\n\nLonger body\nwith two lines.');
  });

  it('reads metadata and the full message', async () => {
    const d = await readCommitDetails('git', dir, git(dir, 'rev-parse', 'HEAD'));
    assert.equal(d.author, 'Grace Hopper');
    assert.equal(d.authorEmail, 'grace@example.com');
    assert.equal(d.authorTime, 1700000000);
    assert.equal(d.committer, 'Committer Bot');
    assert.equal(d.commitTime, 1700000100);
    assert.equal(d.message, 'Change things\n\nLonger body\nwith two lines.');
    assert.deepEqual(d.parents, [git(dir, 'rev-parse', 'HEAD~')]);
    assert.equal(d.base, d.parents[0]);
  });

  it('lists added, modified, deleted and renamed files with unusual names', async () => {
    const d = await readCommitDetails('git', dir, git(dir, 'rev-parse', 'HEAD'));
    const files = [...d.files].sort((a, b) => a.path.localeCompare(b.path));
    assert.deepEqual(files, [
      { status: 'A', path: 'dir/ünïcode.txt' },
      { status: 'D', path: 'gone.txt' },
      { status: 'M', path: 'keep.txt' },
      { status: 'R', path: 'new\tname.txt', oldPath: 'old name.txt' },
    ]);
  });

  it('compares a root commit with the empty tree', async () => {
    const d = await readCommitDetails('git', dir, git(dir, 'rev-parse', 'HEAD~'));
    assert.equal(d.base, undefined);
    assert.deepEqual(d.parentSubjects, []);
    assert.deepEqual(d.files.map((f) => `${f.status} ${f.path}`).sort(), [
      'A gone.txt',
      'A keep.txt',
      'A old name.txt',
    ]);
  });

  it('compares a merge with the requested parent', async () => {
    const b = join(root, 'branchy');
    scenarios.branchy().write(b);
    const merge = git(b, 'rev-parse', ':/Merge branch feature/login');
    const [p1, p2] = git(b, 'rev-parse', `${merge}^1`, `${merge}^2`).split('\n');
    const first = await readCommitDetails('git', b, merge);
    assert.equal(first.base, p1);
    assert.deepEqual(
      first.files.map((f) => f.path),
      ['feature_login.txt'],
    );
    // Subjects line up with the parents, whatever their dates.
    assert.deepEqual(first.parentSubjects, [
      git(b, 'log', '-1', '--format=%s', p1!),
      git(b, 'log', '-1', '--format=%s', p2!),
    ]);
    const second = await readCommitDetails('git', b, merge, p2);
    assert.equal(second.base, p2);
    assert.deepEqual(
      second.files.map((f) => f.path),
      ['main.txt'],
    );
  });

  it('rejects an unknown commit', async () => {
    await assert.rejects(readCommitDetails('git', dir, '0123456789012345678901234567890123456789'));
  });
});
