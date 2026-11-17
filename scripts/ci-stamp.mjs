// CI builds only: marks the packaged extension as a pre-release build, so the Extensions view shows
// which build is installed. The version becomes <major>.<first odd minor above the release's>.<commits
// since package.json became <major>.<minor>.0> (ADR 6), and the README, shown as the extension's
// details page, says the build's commit and date under its header, at the <!-- ci-stamp --> marker.
// Release packaging does not run this. Needs the history back to that commit (no shallow clone).
// Usage: node scripts/ci-stamp.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

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
const base = `${release[1]}.${minor}.0`;
// The commit that set the version to x.y.0: patch releases on top of it keep the count going.
const since = git('log', '--reverse', '--format=%H', `-S"version": "${base}"`, '--', 'package.json').split('\n')[0];
if (!since) {
  console.error(`no commit in the history sets package.json to ${base}`);
  process.exit(1);
}
const commits = git('rev-list', '--count', `${since}..HEAD`);
const sha = git('rev-parse', 'HEAD');
pkg.version = `${release[1]}.${minor % 2 === 0 ? minor + 1 : minor + 2}.${commits}`;
writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
const date = new Date().toISOString().slice(0, 10);
const note = `> CI build ${pkg.version} · commit ${sha.slice(0, 7)} · ${date}. Not a release.`;
writeFileSync('README.md', readme.replace(`${MARKER}\n`, `${MARKER}\n\n${note}\n`));
console.log(`stamped ${pkg.version} (${sha.slice(0, 7)})`);
