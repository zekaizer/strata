// Restart test: start VS Code twice with the same profile and workspace in
// development mode. A driver extension (test/restart/driver.ts) prepares state
// in the first run and checks what was restored in the second.
// Usage: node scripts/restart-test.mjs [stable|1.90.0] [multi]
//   multi: in the multi-repo fixture workspace, the repository shown last comes back with its selection.
import '../test/isolate-git.ts';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { userDataDir } from './lib/test-paths.ts';
import { testSettings } from './lib/test-settings.ts';

const version = process.argv[2] ?? 'stable';
const multi = process.argv[3] === 'multi';
const root = resolve('.');
const workspace = join(root, 'out', 'fixtures', multi ? 'multi-repo' : 'branchy');
const driver = join(root, 'out', 'test', 'restart');
const profile = userDataDir(`restart-${version}${multi ? '-multi' : ''}`);
const result = join(profile, 'result.json');

cpSync('test/restart/package.json', join(driver, 'package.json'));
rmSync(profile, { recursive: true, force: true });
mkdirSync(join(profile, 'User'), { recursive: true });
writeFileSync(join(profile, 'User', 'settings.json'), JSON.stringify(testSettings));

const code = await downloadAndUnzipVSCode(version);
const args = [
  workspace,
  `--extensionDevelopmentPath=${root}`,
  `--extensionDevelopmentPath=${driver}`,
  `--user-data-dir=${profile}`,
  `--extensions-dir=${join(profile, 'extensions')}`,
  '--disable-gpu',
  '--disable-workspace-trust',
  '--skip-welcome',
  '--skip-release-notes',
  // As @vscode/test-electron does for every test run: Chromium's sandbox cannot start as root
  // or where unprivileged user namespaces are restricted (Ubuntu 24.04 CI runners).
  '--no-sandbox',
  '--disable-gpu-sandbox',
  '--disable-updates',
];

async function phase(n) {
  rmSync(result, { force: true });
  let stderr = '';
  await new Promise((done, fail) => {
    const p = spawn(code, args, {
      env: {
        ...process.env,
        STRATA_RESTART_PHASE: `${multi ? 'multi-' : ''}${n}`,
        STRATA_RESTART_RESULT: result,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    p.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-8000);
    });
    const timer = setTimeout(() => {
      p.kill();
      fail(new Error(`phase ${n} timed out`));
    }, 120_000);
    p.on('exit', () => {
      clearTimeout(timer);
      done();
    });
  });
  if (!existsSync(result)) {
    console.error(`phase ${n}: VS Code exited without a result. Last stderr:\n${stderr}`);
    process.exit(1);
  }
  const out = JSON.parse(readFileSync(result, 'utf8'));
  console.log(`phase ${n}:`, out);
  if (out.error) throw new Error(`phase ${n}: ${out.error}`);
  return out;
}

if (multi) {
  const first = await phase(1);
  const second = await phase(2);
  const failures = [];
  if (second.repo !== first.repo) failures.push(`showed ${second.repo} instead of ${first.repo}`);
  if (second.restoredSelection !== first.selected) failures.push('selection not restored');
  if (failures.length) {
    console.error(`restart test (${version}, multi) FAILED: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log(`restart test (${version}, multi) passed: the repository shown last and its selection restored`);
  process.exit(0);
}

const first = await phase(1);
const second = await phase(2);
rmSync(`${result}.restarting`, { force: true });
const third = await phase(3);
const failures = [];
if (second.restoredSelection !== first.selected) failures.push('selection not restored');
if (!second.pinned) failures.push('pin not restored');
if (!second.firstParent) failures.push('view options not restored');
if (!third.reloaded) failures.push(`graph did not load after an extension host restart (${third.reason ?? 'stuck'})`);
else if (!third.selection) failures.push('selection lost after an extension host restart');
if (failures.length) {
  console.error(`restart test (${version}) FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log(
  `restart test (${version}) passed: panel, selection, pin and view options restored; graph reloads after an extension host restart`,
);
