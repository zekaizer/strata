import {
  dropStashConfirmation,
  NOTHING_TO_STASH,
  STASH_DOING,
  STASH_DONE,
  stashBranchDirty,
  stashBranchInput,
  stashLabel,
  stashPushInput,
  staleTarget,
} from '../../core/wording.ts';
import { readCommit, readHead, readStash, readStashTop } from '../../git/facts.ts';
import { runGit } from '../../git/run.ts';
import { readWorktree } from '../../git/state.ts';
import { finish, notify, run, type FlowHost } from '../flow.ts';
import { Outdated } from '../target.ts';
import { reportRestore, restore } from './changes.ts';
import { newName } from './refs.ts';

/** A stash row's stash, as it is now; Outdated when it left the list. */
async function current(host: FlowHost, hash: string) {
  const s = await readStash(host.git, host.cwd, hash);
  if (!s) throw new Outdated(staleTarget(`stash ${hash.slice(0, 7)}`));
  return { ...s, label: stashLabel(s.index, s.message) };
}

const hasUntracked = async (host: FlowHost) =>
  (await runGit(host.git, host.cwd, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '--directory',
    '--no-empty-directory',
    '-z',
  ])) !== '';

export async function stashPush(host: FlowHost, includeUntracked: boolean): Promise<void> {
  const [wt, untracked] = await Promise.all([
    readWorktree(host.git, host.cwd),
    includeUntracked ? hasUntracked(host) : Promise.resolve(false),
  ]);
  if (wt.paths.length === 0 && !untracked) {
    void host.ui.notify('info', NOTHING_TO_STASH);
    return;
  }
  const message = await host.ui.input({
    ...stashPushInput(wt.paths.length, wt.staged, untracked),
    validate: () => undefined,
  });
  if (message === undefined) return;
  const ran = await run(host, STASH_DOING.stashing, (exec) =>
    exec({
      kind: 'stashPush',
      message: message === '' ? undefined : message,
      untracked: includeUntracked ? 'unignored' : 'none',
    }),
  );
  if (ran === undefined) return;
  const top = await readStashTop(host.git, host.cwd);
  const s = top === undefined ? undefined : await readStash(host.git, host.cwd, top);
  if (!s) return;
  await finish(host, { message: STASH_DONE.stashed(wt.paths.length, stashLabel(s.index, s.message)), focus: s.hash });
}

/** Apply (`pop` false) or Pop, judged by what came back rather than by git's exit code. */
export async function restoreStash(host: FlowHost, hash: string, pop: boolean): Promise<void> {
  const s = await current(host, hash);
  const r = await run(host, pop ? STASH_DOING.popping(s.label) : STASH_DOING.applying(s.label), (exec) =>
    restore(host, exec, hash, pop),
  );
  if (r === undefined) return;
  if (r.kind === 'refused') {
    notify(host, 'error', r.reason, ['Show Output'], () => {
      host.runner.showOutput();
    });
    return;
  }
  const done = pop ? STASH_DONE.popped(s.label) : STASH_DONE.applied(s.label);
  // Applied, Strata owes it no restore: popping it again would apply the changes twice.
  if (r.kind === 'restored' && !pop) await host.leftovers.keep(hash);
  await finish(host, { message: done });
  await reportRestore(host, done, r);
}

export async function dropStash(host: FlowHost, hash: string): Promise<void> {
  const s = await current(host, hash);
  // As the graph read it: a stash commit's base and files never change.
  const entry = host.stashes.find((e) => e.hash === hash);
  const base = await readCommit(host.git, host.cwd, entry?.base ?? `${hash}^1`);
  if (!(await host.ui.confirm(dropStashConfirmation(s.index, s.message, entry?.files, base)))) return;
  const ran = await run(host, STASH_DOING.dropping(s.label), async (exec) => {
    // Numbers shift with every push and drop: resolve it again right before dropping.
    const now = await current(host, hash);
    return exec({ kind: 'stashDrop', index: now.index });
  });
  if (ran === undefined) return;
  await finish(host, {
    message: STASH_DONE.dropped(s.label),
    undo: {
      label: 'stash drop',
      repo: host.cwd,
      guard: { kind: 'refs', expect: [] },
      inverse: [{ kind: 'stashStore', commit: hash, message: s.message }],
      focus: hash,
    },
  });
}

export async function stashBranch(host: FlowHost, hash: string): Promise<void> {
  const s = await current(host, hash);
  const [base, wt] = await Promise.all([readCommit(host.git, host.cwd, `${hash}^1`), readWorktree(host.git, host.cwd)]);
  if (wt.paths.length > 0) {
    void host.ui.notify('info', stashBranchDirty(base.short));
    return;
  }
  const name = await host.ui.input({
    ...stashBranchInput(s.index, s.message, base.short),
    validate: newName(host, 'branch'),
  });
  if (name === undefined) return;
  const ran = await run(host, STASH_DOING.branching(name), async (exec) => {
    const now = await current(host, hash);
    return exec({ kind: 'stashBranch', name, index: now.index });
  });
  if (ran === undefined) return;
  await finish(host, { message: STASH_DONE.branched(name, s.label), focus: (await readHead(host.git, host.cwd)).hash });
}
