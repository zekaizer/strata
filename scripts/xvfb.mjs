// Runs a command, under a virtual X server when on Linux without a DISPLAY.
// Usage: node scripts/xvfb.mjs [NAME=value ...] -- <command> [args...]
import { spawn } from 'node:child_process';
import { constants } from 'node:os';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep < 0 || sep === argv.length - 1) {
  console.error('usage: node scripts/xvfb.mjs [NAME=value ...] -- <command> [args...]');
  process.exit(2);
}
const env = { ...process.env };
for (const kv of argv.slice(0, sep)) {
  const i = kv.indexOf('=');
  if (i <= 0) {
    console.error(`invalid environment assignment: ${kv}`);
    process.exit(2);
  }
  env[kv.slice(0, i)] = kv.slice(i + 1);
}
let [cmd, ...args] = argv.slice(sep + 1);
if (process.platform === 'linux' && !env.DISPLAY) {
  args = ['--auto-servernum', `--server-args=-screen 0 ${env.STRATA_SCREEN ?? '1600x1000x24'}`, cmd, ...args];
  cmd = 'xvfb-run';
}
// npm bin shims are .cmd files on Windows and need a shell.
const child = spawn(cmd, args, { env, stdio: 'inherit', shell: process.platform === 'win32' });
child.on('error', (e) => {
  const hint = cmd === 'xvfb-run' ? ' (install the xvfb package, or set DISPLAY)' : '';
  console.error(`failed to start ${cmd}: ${e.message}${hint}`);
  process.exit(127);
});
// Forward termination so xvfb-run, Xvfb and VS Code do not outlive an interrupted run.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => child.kill(sig));
}
child.on('exit', (code, signal) => process.exit(signal ? 128 + (constants.signals[signal] ?? 0) : (code ?? 1)));
