import { untrackedNotRestored } from '../../core/git-error.ts';
import {
  dropStashConfirmation,
  IN_THE_WAY_OF,
  NOTHING_TO_STASH,
  nothingStashed,
  STASH_DOING,
  STASH_DONE,
  stashBranchDirty,
  stashBranchInput,
  stashBranchPartial,
  stashFilesExist,
  stashLabel,
  stashPushInput,
  staleTarget,
} from '../../core/wording.ts';
import {
  readCommit,
  readHead,
  readStash,
  readStashFilesHere,
  readStashFilesUntrackedHere,
  readStashTop,
} from '../../git/facts.ts';
import { GitOpError } from '../../git/op.ts';
import { runGit } from '../../git/run.ts';
import { readWorkingChanges } from '../../git/state.ts';
import { finish, notify, run, type FlowHost } from '../flow.ts';
import { Outdated } from '../target.ts';
import { finishRestoring, restore, runMovingUntracked } from './changes.ts';
import { absent, newName } from './refs.ts';

/** A stash row's stash, as it is now; Outdated when it left the list. */
async function current(host: FlowHost, hash: string) {
  const s = await readStash(host.git, host.cwd, hash);
  if (!s) throw new Outdated(staleTarget(`stash ${hash.slice(0, 7)}`));
  return { ...s, label: stashLabel(s.message) };
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
    readWorkingChanges(host.git, host.cwd),
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
  const before = await readStashTop(host.git, host.cwd);
  const ran = await run(host, STASH_DOING.stashing, (exec) =>
    exec({
      kind: 'stashPush',
      message: message === '' ? undefined : message,
      untracked: includeUntracked ? 'unignored' : 'none',
    }),
  );
  if (ran === undefined) return;
  const top = await readStashTop(host.git, host.cwd);
  // git exits 0 with "No local changes to save" (e.g. only changes inside submodules).
  if (top === before) {
    void host.ui.notify('info', nothingStashed(wt.submodules));
    return;
  }
  const s = top === undefined ? undefined : await readStash(host.git, host.cwd, top);
  if (!s) return;
  await finish(host, { message: STASH_DONE.stashed(wt.paths.length, stashLabel(s.message)), focus: s.hash });
}

/** Apply (`pop` false) or Pop, judged by what came back rather than by git's exit code. */
export async function restoreStash(host: FlowHost, hash: string, pop: boolean): Promise<void> {
  const s = await current(host, hash);
  // git would apply the rest and keep the stash, and applying it again later would apply the rest twice.
  const here = await readStashFilesHere(host.git, host.cwd, hash);
  if (here.length > 0) {
    void host.ui.notify('error', stashFilesExist(s.label, here));
    return;
  }
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
  await finishRestoring(host, r, { message: done }, { label: s.label, pop });
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
  const [base, wt] = await Promise.all([
    readCommit(host.git, host.cwd, `${hash}^1`),
    readWorkingChanges(host.git, host.cwd),
  ]);
  if (wt.paths.length > 0) {
    void host.ui.notify('info', stashBranchDirty(base.short));
    return;
  }
  // git would create the branch, apply the rest and keep the stash.
  const here = await readStashFilesUntrackedHere(host.git, host.cwd, hash);
  if (here.length > 0) {
    void host.ui.notify('error', stashFilesExist(s.label, here, 'create the branch again'));
    return;
  }
  const name = await host.ui.input({
    ...stashBranchInput(s.index, s.message, base.short),
    validate: newName(host, 'branch'),
  });
  if (name === undefined) return;
  // Files that appeared since the check: git makes the branch and applies the rest anyway.
  let missed: string[] = [];
  try {
    // Resolved again inside: a stash that moves untracked files out of the way shifts the numbers.
    const ran = await runMovingUntracked(
      host,
      STASH_DOING.branching(name),
      IN_THE_WAY_OF.stashBranch(name),
      async (exec) => {
        const now = await current(host, hash);
        return exec({ kind: 'stashBranch', name, index: now.index });
      },
      [absent('branch', name)],
    );
    if (ran === undefined) return;
  } catch (e) {
    missed = e instanceof GitOpError ? untrackedNotRestored(e.stderr) : [];
    if (missed.length === 0) throw e;
  }
  const focus = (await readHead(host.git, host.cwd)).hash;
  if (missed.length === 0) {
    await finish(host, { message: STASH_DONE.branched(name, s.label), focus });
    return;
  }
  const message = stashBranchPartial(name, s.label, missed);
  await host.leftovers.keep(hash);
  await finish(host, { message, focus });
  notify(host, 'warning', message, ['Show Stash'], () => {
    host.reveal(hash);
  });
}
