import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { delay, workspaceRoot } from './helpers.ts';

/** git in the workspace, retried while VS Code's git extension holds the index lock. */
export async function gitRetry(...args: string[]): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return execFileSync('git', args, { cwd: workspaceRoot(), encoding: 'utf8', stdio: 'pipe' }).trim();
    } catch (e) {
      if (attempt < 20 && e instanceof Error && /index\.lock/.test(e.message)) await delay(100);
      else throw e;
    }
  }
}

const quiet = (...args: string[]) => gitRetry(...args).catch(() => '');

const refList = async () =>
  new Map(
    (await gitRetry('for-each-ref', '--format=%(refname) %(objectname)'))
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split(' ') as [string, string]),
  );

/**
 * Records the workspace repository's refs, HEAD and config. The returned function puts them
 * back, ends any operation in progress and cleans the work tree, so suites that change the
 * repository leave it as the other suites expect.
 */
export async function snapshotRepo(): Promise<() => Promise<void>> {
  const root = workspaceRoot();
  const configPath = join(root, '.git', 'config');
  const refs = await refList();
  const head = await gitRetry('symbolic-ref', '--quiet', 'HEAD').catch(() => undefined);
  const detached = head === undefined ? await gitRetry('rev-parse', 'HEAD') : undefined;
  const config = readFileSync(configPath, 'utf8');
  return async () => {
    for (const cmd of ['rebase', 'cherry-pick', 'revert', 'merge']) await quiet(cmd, '--quit');
    writeFileSync(configPath, config);
    for (const name of (await refList()).keys()) if (!refs.has(name)) await gitRetry('update-ref', '-d', name);
    for (const [name, hash] of refs) await gitRetry('update-ref', name, hash);
    if (head !== undefined) await gitRetry('symbolic-ref', 'HEAD', head);
    else await gitRetry('update-ref', '--no-deref', 'HEAD', detached!);
    await gitRetry('reset', '--hard', '--quiet');
    await gitRetry('clean', '-fdq');
  };
}

/** Gives the workspace repository the fixtures' identity (CI has none); the snapshot's restore removes it. */
export async function setIdentity(): Promise<void> {
  await gitRetry('config', 'user.name', 'Ada Lovelace');
  await gitRetry('config', 'user.email', 'ada@example.com');
}
