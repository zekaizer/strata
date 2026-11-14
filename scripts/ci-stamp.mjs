// CI builds only: marks the packaged extension as a pre-release build, so the Extensions view shows
// which build is installed. The version becomes <major>.<first odd minor above the release's>.<run>
// (ADR 4: the Marketplace takes numbers only, odd minors are pre-releases) and the README, shown as
// the extension's details page, says the build's commit and date under its header, at the
// <!-- ci-stamp --> marker. Release packaging does not run this.
// Usage: node scripts/ci-stamp.mjs <run number> <commit sha>
import { readFileSync, writeFileSync } from 'node:fs';

const [run, sha] = process.argv.slice(2);
if (!/^\d+$/.test(run ?? '') || !/^[0-9a-f]{40}$/.test(sha ?? '')) {
  console.error('usage: node scripts/ci-stamp.mjs <run number> <40-hex commit sha>');
  process.exit(1);
}

const MARKER = '<!-- ci-stamp -->';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const release = /^(\d+)\.(\d+)\.\d+$/.exec(pkg.version);
if (!release) {
  console.error(`package.json version ${pkg.version} is not <major>.<minor>.<patch>`);
  process.exit(1);
}
const readme = readFileSync('README.md', 'utf8');
if (readme.split('\n').filter((line) => line === MARKER).length !== 1) {
  console.error(`README.md needs exactly one ${MARKER} line, where the build note goes`);
  process.exit(1);
}
if (readme.includes(`${MARKER}\n\n> CI build `)) {
  console.error('README.md already has a build note; not stamping twice');
  process.exit(1);
}

const minor = Number(release[2]);
pkg.version = `${release[1]}.${minor % 2 === 0 ? minor + 1 : minor + 2}.${run}`;
writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
const date = new Date().toISOString().slice(0, 10);
const note = `> CI build ${pkg.version} · commit ${sha.slice(0, 7)} · ${date}. Not a release.`;
writeFileSync('README.md', readme.replace(`${MARKER}\n`, `${MARKER}\n\n${note}\n`));
console.log(`stamped ${pkg.version} (${sha.slice(0, 7)})`);
