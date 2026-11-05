import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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

  it('rejects with the classified error', async () => {
    await assert.rejects(runGitOp('git', dir, ['branch', '-d', 'missing']), (e: unknown) => {
      assert.ok(e instanceof GitOpError);
      assert.equal(e.kind, 'other');
      assert.match(e.message, /branch 'missing' not found/);
      return true;
    });
  });

  it("runs git in the C locale whatever the user's, so its messages stay English", async () => {
    const german = { LANG: 'de_DE.UTF-8', LC_ALL: 'de_DE.UTF-8', LC_MESSAGES: 'de_DE.UTF-8', LANGUAGE: 'de' };
    const saved = Object.fromEntries(Object.keys(german).map((k) => [k, process.env[k]]));
    Object.assign(process.env, german);
    try {
      // gettext ignores LANGUAGE once the locale is C; this git may have no German catalog to show.
      const probe = '!printf %s "$LC_ALL"';
      const { stdout } = await runGitOp('git', dir, ['-c', `alias.locale=${probe}`, 'locale']);
      assert.equal(stdout, 'C');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = v;
      }
    }
  });

  it('classifies a conflict that git reports only on stdout', async () => {
    writeFileSync(join(dir, 'f.txt'), 'stashed\n');
    run(dir, 'stash', 'push', '--quiet');
    writeFileSync(join(dir, 'f.txt'), 'committed\n');
    run(dir, 'commit', '--quiet', '-am', 'change f');
    try {
      await assert.rejects(runGitOp('git', dir, ['stash', 'pop']), (e: unknown) => {
        assert.ok(e instanceof GitOpError);
        assert.equal(e.kind, 'conflict');
        assert.match(e.message, /CONFLICT \(content\)/);
        return true;
      });
    } finally {
      run(dir, 'reset', '--quiet', '--hard');
      run(dir, 'stash', 'drop', '--quiet');
    }
  });

  it('runs git without a terminal ssh could prompt on', async () => {
    // Opening /dev/tty fails without a controlling terminal; ssh would otherwise wait there for a passphrase.
    const probe = "!sh -c 'if (exec 3</dev/tty) 2>/dev/null; then echo terminal; else echo none; fi'";
    const { stdout } = await runGitOp('git', dir, ['-c', `alias.probe=${probe}`, 'probe']);
    assert.equal(stdout.trim(), 'none');
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

  it('rejects on abort only once git and what it started have exited', async () => {
    const marker = join(root, 'exited');
    const slow = `!trap 'sleep 0.3; echo > "${marker}"; exit 1' TERM; sleep 10 & wait`;
    const ac = new AbortController();
    const p = runGitOp('git', dir, ['-c', `alias.slow=${slow}`, 'slow'], { signal: ac.signal });
    setTimeout(() => {
      ac.abort();
    }, 100);
    await assert.rejects(p, { name: 'AbortError' });
    assert.ok(existsSync(marker), 'still running when the abort rejected');
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
