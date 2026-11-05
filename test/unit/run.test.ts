import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runGit } from '../../src/git/run.ts';
import { tempDir } from './helpers.ts';

describe('runGit limits', () => {
  const dir = tempDir('limits');
  // hash-object --stdin waits for input runGit never closes.
  it('stops git after its time budget', async () => {
    await assert.rejects(runGit('git', dir, ['hash-object', '--stdin'], {}, { timeoutMs: 50 }));
  });

  it('rejects output git finishes after its time budget', async () => {
    await assert.rejects(runGit('git', dir, ['--version'], {}, { timeoutMs: 0 }));
    assert.match(await runGit('git', dir, ['--version'], {}, { timeoutMs: 10_000 }), /^git version/);
  });

  it('stops git when its signal aborts', async () => {
    const abort = new AbortController();
    const running = runGit('git', dir, ['hash-object', '--stdin'], {}, { signal: abort.signal });
    abort.abort();
    await assert.rejects(running);
  });
});
