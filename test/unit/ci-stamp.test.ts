import * as assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { tempDir } from './helpers.ts';

const script = fileURLToPath(new URL('../../scripts/ci-stamp.mjs', import.meta.url));
const header = '<p align="center"><img src="media/icon.png" width="96"></p>\n\n<h1 align="center">Strata</h1>\n';
const body = '\n## Features\n\n- Graph\n';

describe('ci-stamp', () => {
  const root = tempDir('ci-stamp');
  let n = 0;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'A',
    GIT_AUTHOR_EMAIL: 'a@example.com',
    GIT_COMMITTER_NAME: 'A',
    GIT_COMMITTER_EMAIL: 'a@example.com',
  };
  const run = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();
  const setVersion = (dir: string, version: string) => {
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'strata', version }, null, 2)}\n`);
  };
  /**
   * A repository whose package.json went through `versions`, one commit each, then `after` more
   * commits; HEAD's README is `readme`.
   */
  const workspace = (readme: string, versions: string[] = ['0.1.0'], after = 0) => {
    const dir = join(root, String(n++));
    mkdirSync(dir);
    run(dir, 'init', '-q');
    writeFileSync(join(dir, 'README.md'), readme);
    for (const v of versions) {
      setVersion(dir, v);
      run(dir, 'add', '-A');
      run(dir, 'commit', '-q', '-m', `v${v}`);
    }
    for (let i = 0; i < after; i++) run(dir, 'commit', '-q', '--allow-empty', '-m', `work ${i}`);
    return dir;
  };
  const stamp = (dir: string) => spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
  const read = (dir: string, file: string) => readFileSync(join(dir, file), 'utf8');
  const version = (dir: string) => (JSON.parse(read(dir, 'package.json')) as { version: string }).version;
  const marked = `${header}\n<!-- ci-stamp -->\n${body}`;

  it('puts the build note under the README header, at its marker', () => {
    const dir = workspace(marked, ['0.1.0'], 2);
    const sha = run(dir, 'rev-parse', 'HEAD');
    assert.equal(stamp(dir).status, 0);
    assert.equal(version(dir), '0.3.2');
    const date = new Date().toISOString().slice(0, 10);
    assert.equal(
      read(dir, 'README.md'),
      `${header}\n<!-- ci-stamp -->\n\n> CI build 0.3.2 · commit ${sha.slice(0, 7)} · ${date}. Not a release.\n${body}`,
    );
  });

  it('versions a build as a pre-release: the next odd minor, the commits since its x.y.0 as its patch', () => {
    for (const [versions, after, stamped] of [
      [['0.1.0'], 0, '0.3.0'],
      [['0.2.0'], 5, '0.3.5'],
      [['1.10.0'], 1, '1.11.1'],
    ] as const) {
      const dir = workspace(marked, [...versions], after);
      assert.equal(stamp(dir).status, 0);
      assert.equal(version(dir), stamped, versions.join());
    }
  });

  it('keeps counting from x.y.0 across patch releases, so builds after a patch stay above those before it', () => {
    const before = workspace(marked, ['0.4.0'], 3);
    assert.equal(stamp(before).status, 0);
    assert.equal(version(before), '0.5.3');
    const dir = workspace(marked, ['0.2.0', '0.4.0'], 3);
    setVersion(dir, '0.4.1');
    run(dir, 'commit', '-q', '-am', 'v0.4.1');
    run(dir, 'commit', '-q', '--allow-empty', '-m', 'after the patch');
    assert.equal(stamp(dir).status, 0);
    assert.equal(version(dir), '0.5.5');
  });

  it('refuses a version whose x.y.0 is not in the history', () => {
    const dir = workspace(marked, ['0.4.1']);
    const r = stamp(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /0\.4\.0/);
    assert.equal(version(dir), '0.4.1');
  });

  it('refuses a version that is not three numbers', () => {
    const dir = workspace(marked, ['0.1.0-beta.1']);
    const r = stamp(dir);
    assert.equal(r.status, 1);
    assert.equal(version(dir), '0.1.0-beta.1');
  });

  it('changes nothing when the README has no marker', () => {
    const readme = `${header}${body}`;
    const dir = workspace(readme);
    const r = stamp(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /<!-- ci-stamp -->/);
    assert.equal(read(dir, 'README.md'), readme);
    assert.equal(version(dir), '0.1.0');
  });

  it('does not stamp twice', () => {
    const dir = workspace(marked);
    assert.equal(stamp(dir).status, 0);
    const readme = read(dir, 'README.md');
    const r = stamp(dir);
    assert.equal(r.status, 1);
    assert.equal(version(dir), '0.3.0');
    assert.equal(read(dir, 'README.md'), readme);
  });
});
