// Refuses a version the Marketplace would take wrongly (ADR 4). A pre-release needs an odd minor and
// must be above every published version. A release needs an even minor and must be above every
// published release; one that starts a minor (x.y.0) also above every published pre-release, which
// previewed it, or pre-release users would never get it. A patch release (x.y.z, z > 0) may stay below
// the pre-releases of the next minor: release users get it, pre-release users keep the newer builds.
// The published versions are read from the Marketplace, or from --published for tests, where a
// trailing "-pre" marks a pre-release.
// Usage: node scripts/release-version.mjs <x.y.z> <release|pre-release> [--published <v1,v2-pre,...>]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [version, kind, flag, list] = process.argv.slice(2);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const parse = (v) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : undefined);

const parts = parse(version ?? '');
if (!parts || (kind !== 'release' && kind !== 'pre-release') || (flag !== undefined && flag !== '--published'))
  fail('usage: node scripts/release-version.mjs <x.y.z> <release|pre-release> [--published <v1,v2-pre,...>]');
if ((parts[1] % 2 === 1) !== (kind === 'pre-release'))
  fail(`${version}: a ${kind} needs an ${kind === 'pre-release' ? 'odd' : 'even'} minor version (ADR 4)`);

let published;
if (flag === '--published') {
  published = (list ? list.split(',') : []).map((v) => ({ version: v.replace(/-pre$/, ''), pre: v.endsWith('-pre') }));
} else {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const out = execFileSync('npx', ['vsce', 'show', `${pkg.publisher}.${pkg.name}`, '--json'], { encoding: 'utf8' });
  // vsce prints "undefined" for an extension the Marketplace does not have.
  published =
    out.trim() === 'undefined'
      ? []
      : JSON.parse(out).versions.map((v) => ({
          version: v.version,
          pre: (v.properties ?? []).some(
            (p) => p.key === 'Microsoft.VisualStudio.Code.PreRelease' && p.value === 'true',
          ),
        }));
}
const above = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
// The versions this one has to be above.
const counted = published.filter((v) => kind === 'pre-release' || parts[2] === 0 || !v.pre);
const highest = counted
  .map((v) => parse(v.version))
  .filter((p) => p !== undefined)
  .sort(above)
  .at(-1);
if (highest && above(parts, highest) <= 0) {
  const what = kind === 'release' && parts[2] > 0 ? 'release' : 'version';
  fail(`${version} is not above ${highest.join('.')}, the highest ${what} on the Marketplace (ADR 4)`);
}
console.log(`${version} fits as a ${kind}${highest ? `, above ${highest.join('.')}` : ''}`);
