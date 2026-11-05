import { join } from 'node:path';
import * as vscode from 'vscode';
import { resolveStashChoices, type DirtyFacts, type StashChoices, type StashOp } from '../../core/autostash.ts';
import { untrackedInTheWay } from '../../core/git-error.ts';
import type { Operation } from '../../core/operations.ts';
import type { Worktree } from '../../core/repo-state.ts';
import {
  autostashRefused,
  dirtySection,
  gitFailure,
  inTheWayConfirmation,
  inTheWayStash,
  OPEN_SCM,
  popConflicted,
  popPartial,
  popRefused,
  stashLabel,
} from '../../core/wording.ts';
import {
  readConfigBool,
  readOverlap,
  readStash,
  readStashTop,
  readUnmerged,
  readUntrackedIn,
} from '../../git/facts.ts';
import { GitOpError } from '../../git/op.ts';
import { runGit } from '../../git/run.ts';
import { readOperationState, readWorktree } from '../../git/state.ts';
import { notify, run, type Expect, type FlowHost } from '../flow.ts';
import type { Exec } from '../runner.ts';

/** Uncommitted changes as an operation meets them, read right before it confirms. */
export interface Changes {
  worktree: Worktree;
  /** Dirty paths the operation's target changes too (switch, reset --keep). */
  overlap: string[];
  dirty: DirtyFacts;
  choices: StashChoices;
  /** The closing section of the confirmation; '' when nothing needs asking. */
  section: string;
  /** The choices with other facts about the operation (a merge that fast-forwards). */
  resolve: (dirty: DirtyFacts) => StashChoices;
}

/** `target`: the commit a switch or a reset --keep moves to, for the overlap. */
export async function changes(host: FlowHost, op: StashOp, target?: string): Promise<Changes> {
  const [worktree, mergeAutoStash] = await Promise.all([
    readWorktree(host.git, host.cwd),
    readConfigBool(host.git, host.cwd, 'merge.autoStash'),
  ]);
  const overlap =
    target !== undefined && (op === 'switch' || op === 'resetKeep')
      ? await readOverlap(host.git, host.cwd, target, worktree.paths)
      : [];
  // Changes inside submodules cannot be stashed and never block: they alone ask nothing.
  const files = Math.max(0, worktree.paths.length - worktree.submodules);
  const dirty = { files, staged: worktree.staged, overlap: overlap.length > 0, fastForward: false };
  const setting = host.settings().autoStash;
  const resolve = (d: DirtyFacts) => resolveStashChoices(op, d, setting, mergeAutoStash);
  const choices = resolve(dirty);
  const section = choices.choices.length > 0 ? dirtySection(dirty, choices, worktree.submodules) : '';
  return { worktree, overlap, dirty, choices, section, resolve };
}

/** A stash as Strata names it. */
export interface StashedRef {
  hash: string;
  index: number;
  message: string;
}

/**
 * How putting stashed changes back ended, judged from the stash list, the unmerged paths and the
 * work tree (a pop that cannot restore untracked files exits 1 having applied the rest).
 */
export type Restored =
  | { kind: 'none' }
  | { kind: 'restored' }
  | { kind: 'conflicted' | 'partial'; stash: StashedRef }
  | { kind: 'refused'; stash: StashedRef; reason: string };

const trackedStatus = (host: FlowHost) =>
  runGit(host.git, host.cwd, ['status', '--porcelain=v2', '-z', '--untracked-files=no']);

/** Pops (or applies) the stash commit `hash`, resolving its index right before. */
export async function restore(host: FlowHost, exec: Exec, hash: string, pop = true): Promise<Restored> {
  const stash = await readStash(host.git, host.cwd, hash);
  // The user popped it by hand meanwhile.
  if (!stash) return { kind: 'none' };
  const before = await trackedStatus(host);
  let error: unknown;
  try {
    await exec(pop ? { kind: 'stashPop', index: stash.index } : { kind: 'stashApply', index: stash.index });
  } catch (e) {
    if (!(e instanceof GitOpError)) throw e;
    error = e;
  }
  if (error === undefined) return { kind: 'restored' };
  if ((await readUnmerged(host.git, host.cwd)).length > 0) return { kind: 'conflicted', stash };
  if ((await trackedStatus(host)) !== before) return { kind: 'partial', stash };
  return { kind: 'refused', stash, reason: gitFailure((error as GitOpError).message).split('\n')[0]! };
}

/**
 * Runs `body` between Strata's own `stash push` and a pop of the stash that push created. A body
 * that stops (fails, leaving its operation in progress) leaves the stash to that operation, whose
 * Continue, Abort or Skip restores it (the error propagates); one that fails otherwise gets the
 * changes back at once.
 */
export async function stashAround(
  host: FlowHost,
  exec: Exec,
  message: string,
  body: () => Promise<unknown>,
): Promise<Restored> {
  const before = await readStashTop(host.git, host.cwd);
  await exec({ kind: 'stashPush', message, untracked: 'none' });
  const after = await readStashTop(host.git, host.cwd);
  // "No local changes to save" (e.g. only submodule changes) creates none, and there is nothing to pop.
  const created = after !== before ? after : undefined;
  if (created !== undefined) await host.leftovers.pushed(created);
  try {
    await body();
  } catch (e) {
    if (created !== undefined) {
      const stopped = e instanceof GitOpError ? await readOperationState(host.git, host.cwd) : undefined;
      if (stopped) await host.leftovers.pushed(created, stopped.applying);
      // Refused before changing anything: give the changes back now.
      else await restore(host, exec, created).catch(() => undefined);
    }
    throw e;
  }
  return created === undefined ? { kind: 'none' } : restore(host, exec, created);
}

/**
 * Runs `steps` as run() does. When git refuses because untracked files are where `op` (as
 * IN_THE_WAY_OF names it) puts files of its own, offers to move exactly those into a stash that
 * Strata never pops, and runs `steps` once more. A first attempt that stashed around itself gave
 * its changes back on the refusal, so the second stashes again.
 */
export async function runMovingUntracked<T>(
  host: FlowHost,
  label: string,
  op: string,
  steps: (exec: Exec) => Promise<T>,
  expect: readonly Expect[] = [],
): Promise<T | undefined> {
  try {
    return await run(host, label, steps, { expect });
  } catch (e) {
    const files = await inTheWay(host, e);
    if (files === undefined) throw e;
    if ((await host.ui.confirm(inTheWayConfirmation(op, files))) === undefined) return undefined;
    return run(
      host,
      label,
      async (exec) => {
        await exec({ kind: 'stashPush', message: inTheWayStash(op), untracked: 'unignored', paths: files });
        return steps(exec);
      },
      { expect },
    );
  }
}

/** The untracked files a refusal names, when that is all that stopped git and it left nothing in progress. */
async function inTheWay(host: FlowHost, e: unknown): Promise<string[] | undefined> {
  if (!(e instanceof GitOpError) || e.kind !== 'untrackedOverwrite') return undefined;
  if (await readOperationState(host.git, host.cwd)) return undefined;
  const listed = untrackedInTheWay(e.stderr);
  return listed.length === 0 ? undefined : readUntrackedIn(host.git, host.cwd, listed);
}

/**
 * Opens conflicted files where VS Code resolves conflicts: one file in the merge editor (with
 * git.mergeEditor) or as a file, several through a pick that also offers Source Control.
 */
export async function resolveConflicts(host: FlowHost, paths: readonly string[]): Promise<void> {
  const uri = (p: string) => vscode.Uri.file(join(host.cwd, p));
  const open = async (p: string) => {
    if (host.settings().mergeEditor) await vscode.commands.executeCommand('git.openMergeEditor', uri(p));
    else await vscode.commands.executeCommand('vscode.open', uri(p));
  };
  const [only] = paths;
  if (paths.length === 1 && only !== undefined) return open(only);
  const picked = await host.ui.pick({
    title: 'Resolve Conflicts',
    items: [...paths.map((p) => ({ label: p, value: p })), { label: OPEN_SCM, value: undefined }],
  });
  if (picked !== undefined) await open(picked);
  else await vscode.commands.executeCommand('workbench.view.scm');
}

/**
 * Tells how putting the stashed changes back after `done` went, when it did not simply work. A
 * stash whose restore conflicted is never offered for restoring again; one restored in part is
 * kept out of the leftover banner, which would advise dropping it.
 */
export async function reportRestore(host: FlowHost, done: string, r: Restored): Promise<void> {
  if (r.kind === 'none' || r.kind === 'restored') return;
  const label = stashLabel(r.stash.index, r.stash.message);
  if (r.kind === 'conflicted') {
    await host.leftovers.markRestoreConflicted(r.stash.hash);
    const paths = await readUnmerged(host.git, host.cwd);
    notify(
      host,
      'warning',
      popConflicted(done, paths, paths.length, label),
      ['Resolve...', 'Show Stash'],
      async (a) => {
        if (a === 'Resolve...') await resolveConflicts(host, paths);
        else host.reveal(r.stash.hash);
      },
    );
    return;
  }
  await host.leftovers.keep(r.stash.hash);
  const message = r.kind === 'refused' ? popRefused(done, r.reason, label) : popPartial(done, label);
  notify(host, 'warning', message, ['Show Stash', 'Show Output'], (a) => {
    if (a === 'Show Stash') host.reveal(r.stash.hash);
    else host.runner.showOutput();
  });
}

/**
 * Runs `op`, which git may autostash around (merge, rebase, their Continue, Abort or Skip, switch
 * --merge), and finds the stash git keeps when it could not put the changes back: a new stash top
 * after a success (exit 0). Read from the stash list, not stderr: git 2.55 reworded the message,
 * and it says the restore conflicted also when git refused to apply the stash at all.
 */
export async function execAutostash(host: FlowHost, exec: Exec, op: Operation): Promise<Restored> {
  const before = await readStashTop(host.git, host.cwd);
  await exec(op);
  const after = await readStashTop(host.git, host.cwd);
  const stash = after === undefined || after === before ? undefined : await readStash(host.git, host.cwd, after);
  if (!stash) return { kind: 'none' };
  if ((await readUnmerged(host.git, host.cwd)).length > 0) return { kind: 'conflicted', stash };
  // git applies a stash whole or not at all: it refused over local changes to files the stash changes.
  const [changed, worktree] = await Promise.all([
    runGit(host.git, host.cwd, ['diff', '--name-only', '-z', '--no-renames', `${stash.hash}^1`, stash.hash, '--']),
    readWorktree(host.git, host.cwd),
  ]);
  const inTheWay = changed.split('\0').filter((p) => worktree.paths.includes(p));
  return { kind: 'refused', stash, reason: autostashRefused(inTheWay) };
}
