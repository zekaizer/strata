import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import {
  HookRefused,
  readLine,
  readRefsHaving,
  readRemoteHaving,
  readUnpushed,
  runCommitMsgHook,
  writeTodo,
} from '../../src/git/rewrite.ts';
import { tempDir } from './helpers.ts';
import { atLeast, HOOK_RUN, parseGitVersion } from '../../src/core/git-version.ts';

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@e',
  GIT_AUTHOR_DATE: '@1700000000 +0900',
  GIT_COMMITTER_NAME: 'c',
  GIT_COMMITTER_EMAIL: 'c@e',
};
const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
const rev = (cwd: string, r: string) => run(cwd, 'rev-parse', r);

describe('reading a rewrite from git', () => {
  const root = tempDir('rewrite-git');
  const origin = join(root, 'origin');
  const dir = join(root, 'repo');
  before(() => {
    mkdirSync(origin);
    run(origin, 'init', '--quiet', '-b', 'main');
    for (const i of [1, 2]) {
      writeFileSync(join(origin, `f${i}`), `${i}\n`);
      run(origin, 'add', '.');
      run(origin, 'commit', '--quiet', '-m', `c${i}`);
    }
    run(root, 'clone', '--quiet', origin, dir);
    for (const i of [3, 4]) {
      writeFileSync(join(dir, `f${i}`), `${i}\n`);
      run(dir, 'add', '.');
      run(dir, 'commit', '--quiet', '-m', `c${i}\n\n# Heading\nbody ${i}`);
    }
    run(dir, 'branch', 'at-c3', 'HEAD~1');
    run(dir, 'tag', '-a', '-m', 'v3', 'v3', 'HEAD~1');
    run(dir, 'branch', 'forked', 'HEAD~1');
    run(dir, 'switch', '--quiet', 'forked');
    writeFileSync(join(dir, 'g'), 'g\n');
    run(dir, 'add', '.');
    run(dir, 'commit', '--quiet', '-m', 'fork');
    run(dir, 'switch', '--quiet', 'main');
  });

  it("reads HEAD's line down to a commit, with trees, authors and raw messages", async () => {
    const line = await readLine('git', dir, rev(dir, 'HEAD~1'));
    assert.deepEqual(
      line.map((c) => c.hash),
      [rev(dir, 'HEAD'), rev(dir, 'HEAD~1')],
    );
    assert.deepEqual(line[0], {
      hash: rev(dir, 'HEAD'),
      parents: [rev(dir, 'HEAD~1')],
      tree: rev(dir, 'HEAD^{tree}'),
      author: { name: 'Ada', email: 'ada@e', date: '1700000000 +0900' },
      message: 'c4\n\n# Heading\nbody 4\n',
    });
    const all = await readLine('git', dir, rev(dir, 'HEAD~3'));
    assert.equal(all.length, 4);
    assert.deepEqual(all[3]!.parents, [], 'down to the root');
  });

  it('tells which commits a remote-tracking branch has, and names one', async () => {
    const unpushed = await readUnpushed('git', dir, rev(dir, 'HEAD~3'));
    assert.deepEqual([...unpushed].sort(), [rev(dir, 'HEAD'), rev(dir, 'HEAD~1')].sort());
    assert.equal((await readUnpushed('git', dir, undefined)).size, 2);
    assert.equal(await readRemoteHaving('git', dir, rev(dir, 'HEAD~2'), 'refs/remotes/origin/main'), 'origin/main');
    assert.equal(await readRemoteHaving('git', dir, rev(dir, 'HEAD'), undefined), undefined);
  });

  it('finds branches and tags that point inside or branched off the rewritten commits', async () => {
    const found = await readRefsHaving('git', dir, rev(dir, 'HEAD~1'));
    assert.deepEqual(
      found.map((r) => [r.name, r.short, r.kind, r.hash]),
      [
        ['refs/heads/at-c3', 'at-c3', 'branch', rev(dir, 'HEAD~1')],
        ['refs/heads/forked', 'forked', 'branch', rev(dir, 'forked')],
        ['refs/heads/main', 'main', 'branch', rev(dir, 'HEAD')],
        ['refs/tags/v3', 'v3', 'tag', rev(dir, 'HEAD~1')],
      ],
      'an annotated tag is peeled',
    );
  });

  it('writes the todo into the git dir', async () => {
    const path = await writeTodo('git', dir, 'noop\n');
    assert.equal(readFileSync(path, 'utf8'), 'noop\n');
    assert.ok(path.startsWith(join(dir, '.git')));
  });

  for (const [label, version] of [
    ['git hook run', undefined],
    ['running the hook itself (git 2.34)', [2, 34, 0] as const],
  ] as const) {
    const gitVersion = parseGitVersion(execFileSync('git', ['version'], { encoding: 'utf8' }))!;
    const skip = version === undefined && !atLeast(gitVersion, HOOK_RUN) ? 'git hook run needs git 2.36' : false;
    it(`runs the commit-msg hook on a message: ${label}`, { skip }, async () => {
      const d = join(root, `hooks-${version === undefined ? 'run' : 'self'}`);
      mkdirSync(d);
      run(d, 'init', '--quiet');
      assert.equal(await runCommitMsgHook('git', d, version, 'subject\n'), 'subject\n', 'no hook: as written');
      mkdirSync(join(d, 'my-hooks'));
      const hook = join(d, 'my-hooks', 'commit-msg');
      writeFileSync(hook, '#!/bin/sh\nprintf "\\nChange-Id: I1\\n" >> "$1"\n');
      chmodSync(hook, 0o755);
      run(d, 'config', 'core.hooksPath', 'my-hooks');
      assert.equal(await runCommitMsgHook('git', d, version, 'subject\n'), 'subject\n\nChange-Id: I1\n');
      writeFileSync(hook, '#!/bin/sh\necho "missing ticket" >&2\nexit 1\n');
      await assert.rejects(runCommitMsgHook('git', d, version, 'subject\n'), (e: unknown) => {
        assert.ok(e instanceof HookRefused);
        assert.match(e.message, /missing ticket/);
        return true;
      });
    });
  }
});
