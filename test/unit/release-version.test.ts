import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const script = fileURLToPath(new URL('../../scripts/release-version.mjs', import.meta.url));
const check = (version: string, kind: string, published: string[]) =>
  spawnSync(process.execPath, [script, version, kind, '--published', published.join(',')], { encoding: 'utf8' });

describe('release-version', () => {
  // As on the Marketplace after 0.4.0: pre-releases end in -pre.
  const published = ['0.1.0', '0.2.0', '0.3.60-pre', '0.3.67-pre', '0.4.0', '0.5.71-pre'];

  it('takes a release that starts a minor above every published version', () => {
    assert.equal(check('0.6.0', 'release', published).status, 0);
    assert.equal(check('1.0.0', 'release', published).status, 0);
    assert.equal(check('0.2.0', 'release', []).status, 0, 'nothing published yet');
  });

  it('refuses a release that starts a minor below a published pre-release', () => {
    const r = check('0.2.0', 'release', ['0.1.0', '0.3.67-pre']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /0\.2\.0 is not above 0\.3\.67, the highest version/);
  });

  it('takes a patch release below the pre-releases of the next minor', () => {
    assert.equal(check('0.4.1', 'release', published).status, 0);
  });

  it('refuses a patch release that is not above every published release', () => {
    assert.match(check('0.2.1', 'release', published).stderr, /0\.2\.1 is not above 0\.4\.0, the highest release/);
    assert.equal(check('0.4.0', 'release', published).status, 1);
  });

  it('takes a pre-release with an odd minor above every published version', () => {
    assert.equal(check('0.5.72', 'pre-release', published).status, 0);
    assert.equal(check('0.5.72', 'pre-release', [...published, '0.4.1']).status, 0);
  });

  it('refuses a pre-release that is not above every published version', () => {
    assert.equal(check('0.5.71', 'pre-release', published).status, 1);
    assert.equal(check('0.3.68', 'pre-release', published).status, 1);
  });

  it('refuses a minor that does not fit the kind', () => {
    assert.match(check('0.5.0', 'release', published).stderr, /a release needs an even minor/);
    assert.match(check('0.6.1', 'pre-release', published).stderr, /a pre-release needs an odd minor/);
  });

  it('compares versions as numbers, not text', () => {
    assert.equal(check('0.10.0', 'release', ['0.9.5']).status, 0);
    assert.equal(check('0.3.100', 'pre-release', ['0.3.99-pre']).status, 0);
  });

  it('refuses what is not a version or a kind', () => {
    assert.equal(check('v0.4.0', 'release', []).status, 1);
    assert.equal(check('0.4.0', 'stable', []).status, 1);
  });
});
