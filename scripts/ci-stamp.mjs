// CI builds only: marks the packaged extension as a CI build, so the Extensions view shows which
// build is installed. The version becomes <version>-ci.<run> (a pre-release of the next release, so
// a release of the same version replaces it) and the README, shown as the extension's details page,
// starts with the build's commit and date. Release packaging does not run this.
// Usage: node scripts/ci-stamp.mjs <run number> <commit sha>
import { readFileSync, writeFileSync } from 'node:fs';

const [run, sha] = process.argv.slice(2);
if (!/^\d+$/.test(run ?? '') || !/^[0-9a-f]{40}$/.test(sha ?? '')) {
  console.error('usage: node scripts/ci-stamp.mjs <run number> <40-hex commit sha>');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (pkg.version.includes('-')) {
  console.error(`package.json version ${pkg.version} is already a pre-release; not stamping twice`);
  process.exit(1);
}
pkg.version = `${pkg.version}-ci.${run}`;
writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);

const date = new Date().toISOString().slice(0, 10);
const readme = readFileSync('README.md', 'utf8');
const [title, ...rest] = readme.split('\n');
const note = `> CI build ${pkg.version} · commit ${sha.slice(0, 7)} · ${date}. Not a release.`;
writeFileSync('README.md', [title, '', note, ...rest].join('\n'));
console.log(`stamped ${pkg.version} (${sha.slice(0, 7)})`);
