import * as assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { readCommitDetails } from '../../src/git/details.ts';
import { LogReader } from '../../src/git/log-reader.ts';
import { RepoBuilder } from '../fixtures/builder.ts';
import { scenarios } from '../fixtures/scenarios.ts';
import { git, tempDir } from './helpers.ts';

/** Sets environment variables for the duration of the suite. */
function withEnv(vars: Record<string, string>): void {
  const saved: Record<string, string | undefined> = {};
  before(() => {
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  });
}

const root = tempDir('git-env');
const unicode = join(root, 'unicode');
const other = join(root, 'other');
const b = new RepoBuilder();
// Latin-1 representable on purpose: git keeps UTF-8 as is when re-encoding would fail.
b.commit('main', 'café résumé', { author: 'José Ñandú <jose@example.com>' });
b.write(unicode);
scenarios.linear().write(other);

describe('git output encoding', () => {
  const config = join(root, 'gitconfig-latin1');
  writeFileSync(config, '[i18n]\n\tlogOutputEncoding = ISO-8859-1\n');
  withEnv({ GIT_CONFIG_GLOBAL: config });

  it('reads UTF-8 log output whatever i18n.logOutputEncoding says', async () => {
    const r = new LogReader({ git: 'git', cwd: unicode });
    const { commits } = await r.next(10);
    r.dispose();
    assert.equal(commits[0]!.subject, 'café résumé');
    assert.equal(commits[0]!.author, 'José Ñandú');
  });

  it('reads UTF-8 commit details whatever i18n.logOutputEncoding says', async () => {
    const d = await readCommitDetails('git', unicode, git(unicode, 'rev-parse', 'HEAD'));
    assert.equal(d.message, 'café résumé');
    assert.equal(d.author, 'José Ñandú');
  });
});

describe('inherited repository environment', () => {
  withEnv({ GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other });

  it('reads the repository at cwd, not the one GIT_DIR names', async () => {
    const r = new LogReader({ git: 'git', cwd: unicode });
    const { commits } = await r.next(100);
    r.dispose();
    assert.equal(commits.length, 1);
  });
});

describe('LogReader argument and failure handling', () => {
  it('rejects negative and fractional counts', async () => {
    const r = new LogReader({ git: 'git', cwd: other });
    await assert.rejects(r.next(-1), RangeError);
    await assert.rejects(r.next(1.5), RangeError);
    assert.equal((await r.next(1)).commits.length, 1, 'a bad request does not block later ones');
    r.dispose();
  });

  it('names the missing directory instead of reporting ENOENT for git', async () => {
    const r = new LogReader({ git: 'git', cwd: join(root, 'does-not-exist') });
    await assert.rejects(r.next(1), /does-not-exist/);
    r.dispose();
  });
});
