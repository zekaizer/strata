import { join } from 'node:path';
import * as vscode from 'vscode';
import { resolveStashChoices, type DirtyFacts, type StashChoices, type StashOp } from '../../core/autostash.ts';
import type { Worktree } from '../../core/repo-state.ts';
import {
  dirtySection,
  gitFailure,
  OPEN_SCM,
  popConflicted,
  popPartial,
  popRefused,
  stashLabel,
} from '../../core/wording.ts';
import { readConfigBool, readOverlap, readStash, readStashTop, readUnmerged } from '../../git/facts.ts';
import { GitOpError } from '../../git/op.ts';
import { runGit } from '../../git/run.ts';
import { readWorktree } from '../../git/state.ts';
import { notify, type FlowHost } from '../flow.ts';
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
  const dirty = { files, staged: worktree.staged, overlap: overlap.length > 0 };
  const choices = resolveStashChoices(op, dirty, host.settings().autoStash, mergeAutoStash);
  const section = choices.choices.length > 0 ? dirtySection(dirty, choices, worktree.submodules) : '';
  return { worktree, overlap, dirty, choices, section };
}

export const isConflict = (e: unknown): e is GitOpError => e instanceof GitOpError && e.kind === 'conflict';

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
 * that stops at conflicts keeps the stash for after the operation (the error propagates); one
 * that fails otherwise gets the changes back at once.
 */
export async function stashAround(
  host: FlowHost,
  exec: Exec,
  message: string,
  body: () => Promise<unknown>,
): Promise<Restored> {
  const before = await readStashTop(host.git, host.cwd);
  await exec({ kind: 'stashPush', message, includeUntracked: false });
  const after = await readStashTop(host.git, host.cwd);
  // "No local changes to save" (e.g. only submodule changes) creates none, and there is nothing to pop.
  const created = after !== before ? after : undefined;
  try {
    await body();
  } catch (e) {
    // Refused before changing anything: give the changes back now.
    if (!isConflict(e) && created !== undefined) await restore(host, exec, created).catch(() => undefined);
    throw e;
  }
  return created === undefined ? { kind: 'none' } : restore(host, exec, created);
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

/** After git's own autostash: "Applying autostash resulted in conflicts." on a success (exit 0). */
export async function gitRestoreConflicted(host: FlowHost, stderr: string): Promise<Restored> {
  if (!stderr.includes('Applying autostash resulted in conflicts.')) return { kind: 'none' };
  const top = await readStashTop(host.git, host.cwd);
  const stash = top === undefined ? undefined : await readStash(host.git, host.cwd, top);
  return stash ? { kind: 'conflicted', stash } : { kind: 'none' };
}
