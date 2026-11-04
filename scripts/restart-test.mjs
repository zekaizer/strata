// Restart test: start VS Code twice with the same profile and workspace in
// development mode. A driver extension (test/restart/driver.ts) prepares state
// in the first run and checks what was restored in the second.
// Usage: node scripts/restart-test.mjs [stable|1.90.0]
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { userDataDir } from './lib/test-paths.ts';
import { testSettings } from './lib/test-settings.ts';

const version = process.argv[2] ?? 'stable';
const root = resolve('.');
const workspace = join(root, 'out', 'fixtures', 'branchy');
const driver = join(root, 'out', 'test', 'restart');
const profile = userDataDir(`restart-${version}`);
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
  ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
];

async function phase(n) {
  rmSync(result, { force: true });
  await new Promise((done, fail) => {
    const p = spawn(code, args, {
      env: { ...process.env, STRATA_RESTART_PHASE: String(n), STRATA_RESTART_RESULT: result },
      stdio: 'ignore',
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
  const out = JSON.parse(readFileSync(result, 'utf8'));
  console.log(`phase ${n}:`, out);
  if (out.error) throw new Error(`phase ${n}: ${out.error}`);
  return out;
}

const first = await phase(1);
const second = await phase(2);
const failures = [];
if (second.restoredSelection !== first.selected) failures.push('selection not restored');
if (!second.pinned) failures.push('pin not restored');
if (!second.firstParent) failures.push('view options not restored');
if (failures.length) {
  console.error(`restart test (${version}) FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`restart test (${version}) passed: panel, selection, pin and view options restored`);
