import { join } from 'node:path';
import * as vscode from 'vscode';
import { resolveStashChoices, type DirtyFacts, type StashChoices, type StashOp } from '../../core/autostash.ts';
import type { Worktree } from '../../core/repo-state.ts';
import { dirtySection, popConflicted } from '../../core/wording.ts';
import { readConfigBool, readOverlap, readStashIndex, readStashTop, readUnmerged } from '../../git/facts.ts';
import { GitOpError } from '../../git/op.ts';
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
  const dirty = { files: worktree.paths.length, staged: worktree.staged, overlap: overlap.length > 0 };
  const choices = resolveStashChoices(op, dirty, host.settings().autoStash, mergeAutoStash);
  const section = choices.choices.length > 0 ? dirtySection(dirty, choices, worktree.submodules) : '';
  return { worktree, overlap, dirty, choices, section };
}

const isConflict = (e: unknown) => e instanceof GitOpError && e.kind === 'conflict';

/**
 * Runs `body` between Strata's own `stash push` and `stash pop`. A body that stops at conflicts
 * keeps the stash for after the operation (the error propagates); one that fails otherwise gets
 * the changes back at once. Resolves whether popping conflicted (the stash is then kept).
 */
export async function stashAround(
  host: FlowHost,
  exec: Exec,
  message: string,
  body: () => Promise<unknown>,
): Promise<'restored' | 'conflicted'> {
  const before = await readStashTop(host.git, host.cwd);
  await exec({ kind: 'stashPush', message, includeUntracked: false });
  const after = await readStashTop(host.git, host.cwd);
  // "No local changes to save" (e.g. only submodule changes) creates none, and there is nothing to pop.
  const created = after !== before ? after : undefined;
  const pop = async (): Promise<'restored' | 'conflicted'> => {
    const index = created === undefined ? undefined : await readStashIndex(host.git, host.cwd, created);
    if (index === undefined) return 'restored';
    try {
      await exec({ kind: 'stashPop', index });
      return 'restored';
    } catch (e) {
      if (isConflict(e)) return 'conflicted';
      throw e;
    }
  };
  try {
    await body();
  } catch (e) {
    // Refused before changing anything: give the changes back now.
    if (!isConflict(e)) await pop().catch(() => undefined);
    throw e;
  }
  return pop();
}

/** Opens the conflicted files where VS Code resolves conflicts. */
export async function resolveConflicts(host: FlowHost, paths: readonly string[]): Promise<void> {
  const [only] = paths;
  if (paths.length === 1 && only !== undefined && host.settings().mergeEditor)
    await vscode.commands.executeCommand('git.openMergeEditor', vscode.Uri.file(join(host.cwd, only)));
  else await vscode.commands.executeCommand('workbench.view.scm');
}

/** After `done`, putting the stashed changes back conflicted; the stash is kept. */
export async function warnRestoreConflict(host: FlowHost, done: string): Promise<void> {
  const paths = await readUnmerged(host.git, host.cwd);
  notify(host, 'warning', popConflicted(done, paths, paths.length), ['Resolve...', 'Show Output'], async (action) => {
    if (action === 'Resolve...') await resolveConflicts(host, paths);
    else host.runner.showOutput();
  });
}
