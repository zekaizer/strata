import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { GitOpError, runGitOp } from '../../src/git/op.ts';
import { tempDir } from './helpers.ts';

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'a',
  GIT_AUTHOR_EMAIL: 'a@e',
  GIT_COMMITTER_NAME: 'a',
  GIT_COMMITTER_EMAIL: 'a@e',
};
const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

describe('runGitOp', () => {
  const root = tempDir('op');
  const dir = join(root, 'repo');
  before(() => {
    mkdirSync(dir);
    run(dir, 'init', '--quiet', '-b', 'main');
    writeFileSync(join(dir, 'f.txt'), 'a\n');
    run(dir, 'add', '.');
    run(dir, 'commit', '--quiet', '-m', 'root');
  });

  it('runs git and returns its output', async () => {
    const { stdout } = await runGitOp('git', dir, ['branch', '--list', 'main']);
    assert.match(stdout, /main/);
  });

  it('rejects with the classified error, in English whatever the locale', async () => {
    process.env['LANG'] = 'de_DE.UTF-8';
    try {
      await assert.rejects(runGitOp('git', dir, ['branch', '-d', 'missing']), (e: unknown) => {
        assert.ok(e instanceof GitOpError);
        assert.equal(e.kind, 'other');
        assert.match(e.message, /branch 'missing' not found/);
        return true;
      });
    } finally {
      delete process.env['LANG'];
    }
  });

  it('kills git on abort', async () => {
    const ac = new AbortController();
    const p = runGitOp('git', dir, ['-c', 'alias.wait=!sleep 10', 'wait'], { signal: ac.signal });
    setTimeout(() => {
      ac.abort();
    }, 50);
    const started = Date.now();
    await assert.rejects(p, { name: 'AbortError' });
    assert.ok(Date.now() - started < 5000);
  });

  it('never opens an editor or prompts', async () => {
    run(dir, 'checkout', '--quiet', '-b', 'side');
    writeFileSync(join(dir, 'g.txt'), 'g\n');
    run(dir, 'add', '.');
    run(dir, 'commit', '--quiet', '-m', 'side');
    run(dir, 'checkout', '--quiet', 'main');
    await runGitOp('git', dir, ['merge', '--no-ff', 'side'], {
      env: { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@e', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@e' },
    });
    assert.equal(run(dir, 'log', '-1', '--format=%s'), "Merge branch 'side'");
  });
});
