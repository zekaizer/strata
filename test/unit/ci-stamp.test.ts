import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { tempDir } from './helpers.ts';

const script = fileURLToPath(new URL('../../scripts/ci-stamp.mjs', import.meta.url));
const sha = '0123456789abcdef0123456789abcdef01234567';
const header = '<p align="center"><img src="media/icon.png" width="96"></p>\n\n<h1 align="center">Strata</h1>\n';
const body = '\n## Features\n\n- Graph\n';

describe('ci-stamp', () => {
  const root = tempDir('ci-stamp');
  let n = 0;
  const workspace = (readme: string, version = '0.1.0') => {
    const dir = join(root, String(n++));
    mkdirSync(dir);
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'strata', version }, null, 2)}\n`);
    writeFileSync(join(dir, 'README.md'), readme);
    return dir;
  };
  const stamp = (dir: string) => spawnSync(process.execPath, [script, '42', sha], { cwd: dir, encoding: 'utf8' });
  const read = (dir: string, file: string) => readFileSync(join(dir, file), 'utf8');
  const version = (dir: string) => (JSON.parse(read(dir, 'package.json')) as { version: string }).version;

  it('puts the build note under the README header, at its marker', () => {
    const dir = workspace(`${header}\n<!-- ci-stamp -->\n${body}`);
    assert.equal(stamp(dir).status, 0);
    assert.equal(version(dir), '0.1.0-ci.42');
    const date = new Date().toISOString().slice(0, 10);
    assert.equal(
      read(dir, 'README.md'),
      `${header}\n<!-- ci-stamp -->\n\n> CI build 0.1.0-ci.42 · commit 0123456 · ${date}. Not a release.\n${body}`,
    );
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

  it('does not stamp a pre-release twice', () => {
    const dir = workspace(`${header}\n<!-- ci-stamp -->\n${body}`, '0.1.0-ci.41');
    assert.equal(stamp(dir).status, 1);
    assert.equal(version(dir), '0.1.0-ci.41');
  });
});
