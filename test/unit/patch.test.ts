import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { patchStats } from '../../src/core/patch.ts';
import { readCommitPatch, readFilePatch } from '../../src/git/patch.ts';
import { tempDir } from './helpers.ts';

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Grace Hopper',
  GIT_AUTHOR_EMAIL: 'grace@example.com',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'Committer Bot',
  GIT_COMMITTER_EMAIL: 'bot@example.com',
  GIT_COMMITTER_DATE: '1700000100 +0000',
};
const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

describe('readCommitPatch', () => {
  const root = tempDir('patch');
  const dir = join(root, 'repo');
  const ids: Record<string, string> = {};
  before(() => {
    mkdirSync(dir);
    run(dir, 'init', '--quiet', '-b', 'main');
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    run(dir, 'add', '.');
    run(dir, 'commit', '--quiet', '-m', 'root');
    ids['root'] = run(dir, 'rev-parse', 'HEAD');
    writeFileSync(join(dir, 'a.txt'), 'one\n2\nthree\n');
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 255, 0, 7]));
    run(dir, 'add', '.');
    run(dir, 'commit', '--quiet', '-m', 'Change a\n\nWith a body.');
    ids['change'] = run(dir, 'rev-parse', 'HEAD');
    run(dir, 'checkout', '--quiet', '-b', 'topic', ids['root']);
    writeFileSync(join(dir, 'b.txt'), 'topic\n');
    run(dir, 'add', '.');
    run(dir, 'commit', '--quiet', '-m', 'Add b');
    run(dir, 'checkout', '--quiet', 'main');
    run(dir, 'merge', '--quiet', '--no-ff', '-m', 'Merge topic', 'topic');
    ids['merge'] = run(dir, 'rev-parse', 'HEAD');
    // User config that would corrupt a copied patch.
    run(dir, 'config', 'diff.noprefix', 'true');
    run(dir, 'config', 'color.ui', 'always');
  });

  const applies = (base: string, patch: string, expectTree: string) => {
    const w = join(root, `apply-${Object.keys(ids).length}-${Math.abs(patch.length)}`);
    run(root, 'clone', '--quiet', dir, w);
    run(w, 'checkout', '--quiet', '--detach', base);
    execFileSync('git', ['am', '--quiet'], { cwd: w, env, input: patch });
    assert.equal(run(w, 'rev-parse', 'HEAD^{tree}'), expectTree);
  };

  it('is an mbox email that git am turns back into the same commit', async () => {
    const p = await readCommitPatch('git', dir, ids['change']!);
    assert.match(p, new RegExp(`^From ${ids['change']} `));
    assert.match(p, /^From: Grace Hopper <grace@example.com>$/m);
    assert.match(p, /^Subject: \[PATCH\] Change a$/m);
    assert.match(p, /^With a body\.$/m);
    assert.match(p, /^diff --git a\/a\.txt b\/a\.txt$/m, 'prefixes survive diff.noprefix');
    assert.ok(!p.includes('\u001b['), 'no color codes');
    assert.match(p, /^GIT binary patch$/m);
    applies(ids['root']!, p, run(dir, 'rev-parse', `${ids['change']}^{tree}`));
  });

  it('diffs a merge against its first parent', async () => {
    const p = await readCommitPatch('git', dir, ids['merge']!);
    assert.match(p, /^Subject: \[PATCH\] Merge topic$/m);
    assert.match(p, /^diff --git a\/b\.txt b\/b\.txt$/m);
    assert.doesNotMatch(p, /a\.txt/);
    applies(ids['change']!, p, run(dir, 'rev-parse', `${ids['merge']}^{tree}`));
  });

  it('shows every file of a root commit as added', async () => {
    const p = await readCommitPatch('git', dir, ids['root']!);
    assert.match(p, /^new file mode 100644$/m);
    assert.match(p, /^\+one$/m);
  });

  it('rejects anything but a commit id', async () => {
    await assert.rejects(readCommitPatch('git', dir, '--output=/tmp/x'), /invalid commit id/);
  });
});

describe('readFilePatch', () => {
  const root = tempDir('file-patch');
  const dir = join(root, 'repo');
  let first = '';
  let second = '';
  before(() => {
    mkdirSync(dir);
    run(dir, 'init', '--quiet', '-b', 'main');
    writeFileSync(join(dir, 'old name.txt'), 'line\n'.repeat(30));
    writeFileSync(join(dir, 'other.txt'), 'x\n');
    run(dir, 'add', '.');
    run(dir, 'commit', '--quiet', '-m', 'root');
    first = run(dir, 'rev-parse', 'HEAD');
    run(dir, 'mv', 'old name.txt', 'new name.txt');
    writeFileSync(join(dir, 'new name.txt'), 'line\n'.repeat(29) + 'last\n');
    writeFileSync(join(dir, 'other.txt'), 'y\n');
    run(dir, 'add', '-A');
    run(dir, 'commit', '--quiet', '-m', 'rename');
    second = run(dir, 'rev-parse', 'HEAD');
    run(dir, 'config', 'diff.noprefix', 'true');
  });

  it('is only that file, with the rename kept', async () => {
    const p = await readFilePatch('git', dir, second, first, {
      status: 'R',
      path: 'new name.txt',
      oldPath: 'old name.txt',
    });
    assert.match(p, /^diff --git a\/old name\.txt b\/new name\.txt$/m);
    assert.match(p, /^rename from old name\.txt$/m);
    assert.match(p, /^\+last$/m);
    assert.doesNotMatch(p, /other\.txt/);
    assert.doesNotMatch(p, /^From /m, 'a plain diff, not an email');
  });

  it('diffs a root commit file against the empty tree', async () => {
    const p = await readFilePatch('git', dir, first, undefined, { status: 'A', path: 'other.txt' });
    assert.match(p, /^new file mode 100644$/m);
    assert.match(p, /^\+x$/m);
  });
});

describe('patchStats', () => {
  it('counts files and changed lines, not headers or the email body', () => {
    const patch = [
      'From abc Mon Sep 17 00:00:00 2001',
      'Subject: [PATCH] x',
      '',
      '--- a body line that looks like a header',
      '---',
      ' a.txt | 2 +-',
      '',
      'diff --git a/a.txt b/a.txt',
      'index 1..2 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,3 +1,3 @@',
      ' one',
      '-two',
      '+2',
      '+2b',
      ' three',
      'diff --git a/bin.dat b/bin.dat',
      'new file mode 100644',
      'GIT binary patch',
      'literal 6',
      'Ncmb=7',
      '',
    ].join('\n');
    assert.deepEqual(patchStats(patch), { files: 2, insertions: 2, deletions: 1 });
  });

  it('is zero for an empty patch', () => {
    assert.deepEqual(patchStats(''), { files: 0, insertions: 0, deletions: 0 });
  });
});
