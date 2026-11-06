// Runs a command with GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_COMMON_DIR and
// GIT_OBJECT_DIRECTORY pointing at a scratch repository (as inside `git rebase --exec`), and fails
// if the command changed anything in it. Proves the test suites never write into the repository
// they were started from. Usage: node scripts/git-isolation.ts <command> [args...]
//   e.g. node scripts/git-isolation.ts npm run test:unit
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { REPOSITORY_OVERRIDES } from '../src/git/env.ts';

const [cmd, ...args] = process.argv.slice(2);
if (cmd === undefined) {
  console.error('usage: node scripts/git-isolation.ts <command> [args...]');
  process.exit(2);
}

const clean = { ...process.env };
for (const k of REPOSITORY_OVERRIDES) Reflect.deleteProperty(clean, k);
const scratch = mkdtempSync(join(process.env['STRATA_TEST_TMP'] ?? tmpdir(), 'strata-outer-'));
const git = (...a: string[]) => execFileSync('git', a, { cwd: scratch, env: clean, encoding: 'utf8' });
git('-c', 'init.defaultBranch=main', 'init', '--quiet');
git('-c', 'user.name=Outer', '-c', 'user.email=outer@example.com', 'commit', '--quiet', '--allow-empty', '-m', 'outer');

/** Every file and directory of the scratch repository with its size and modification time. */
function snapshot(): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of readdirSync(scratch, { recursive: true, withFileTypes: true })) {
    const path = join(e.parentPath, e.name);
    const s = statSync(path);
    out.set(relative(scratch, path), `${s.size} ${s.mtimeMs}`);
  }
  return out;
}

const before = snapshot();
const gitDir = join(scratch, '.git');
const outer = {
  GIT_DIR: gitDir,
  GIT_WORK_TREE: scratch,
  GIT_INDEX_FILE: join(gitDir, 'index'),
  GIT_COMMON_DIR: gitDir,
  GIT_OBJECT_DIRECTORY: join(gitDir, 'objects'),
};
// npm bin shims are .cmd files on Windows and need a shell.
const run = spawnSync(cmd, args, {
  env: { ...clean, ...outer },
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
const after = snapshot();
const changed = [...new Set([...before.keys(), ...after.keys()])].filter((p) => before.get(p) !== after.get(p)).sort();
if (changed.length > 0) {
  console.error(`\n${cmd} ${args.join(' ')} changed the repository GIT_DIR named (${scratch}):`);
  for (const p of changed.slice(0, 40)) console.error(`  ${before.has(p) ? (after.has(p) ? 'M' : 'D') : 'A'} ${p}`);
  if (changed.length > 40) console.error(`  ... and ${changed.length - 40} more`);
  process.exit(1);
}
rmSync(scratch, { recursive: true, force: true });
console.log(`\n${cmd} ${args.join(' ')} left the repository GIT_DIR named untouched.`);
process.exit(run.status ?? 1);
