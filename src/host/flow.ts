import * as vscode from 'vscode';
import type { AutostashSetting } from '../core/autostash.ts';
import { argv, type Operation } from '../core/operations.ts';
import type { RefSnapshot } from '../core/refs.ts';
import type { OperationState } from '../core/repo-state.ts';
import type { StashEntry } from '../core/stash.ts';
import { shellCommand, shellKind } from '../core/shell.ts';
import {
  changedMeanwhile,
  commandUnquotable,
  gitFailure,
  quote,
  signInConfirmation,
  undoGone,
  undoLabel,
  undoMovedConfirmation,
  undone,
} from '../core/wording.ts';
import { readCommit, readHead } from '../git/facts.ts';
import { GitOpError } from '../git/op.ts';
import { runGit } from '../git/run.ts';
import { commandLine, type Exec, type OpRunner, type RunnerHost } from './runner.ts';
import { Outdated } from './target.ts';
import type { Ui } from './ui.ts';

/** VS Code settings flows follow, read fresh each time. */
export interface FlowSettings {
  autoStash: AutostashSetting;
  /** git.branchPrefix: what a new branch name starts with. */
  branchPrefix: string;
  allowForcePush: boolean;
  /** git.mergeEditor: resolve a conflicted file in the merge editor. */
  mergeEditor: boolean;
}

/**
 * What Undo Last Operation runs, and what must still hold for it to run. The graph drops it when
 * the repository changes or HEAD moves to another branch.
 */
export interface Undo {
  /** What it undoes, as in "Undid the {label}": "merge", "branch deletion". */
  label: string;
  /** The repository it belongs to (its root). */
  repo: string;
  /**
   * `head`: the operation moved the branch HEAD is on (`ref`, or 'HEAD' when detached) from
   * `before` to `after`; Undo needs HEAD still on `ref`, and asks first when `ref` moved since.
   * `deletes` names a branch Undo deletes (create branch). `refs`: refs HEAD is not on, which
   * must still be where the operation left them.
   */
  guard:
    { kind: 'head'; ref: string; before: string; after: string; deletes?: string } | { kind: 'refs'; expect: Expect[] };
  inverse: Operation[];
  /** The commit to select afterwards. */
  focus?: string;
}

/** What the extension gives every graph: the one runner, the Ui (tests replace it), workspace state. */
export interface FlowEnv {
  readonly runner: OpRunner;
  ui: Ui;
  readonly state: vscode.Memento;
}

/** What Strata remembers about the stashes it pushed or restored in the graph's worktree (StashMark). */
export interface Leftovers {
  /** Strata pushed it before an operation; `head`: the stopped cherry pick or revert now holding it. */
  pushed(hash: string, head?: string): Promise<void>;
  /** The stash Strata pushed for the stopped cherry pick or revert `operation`, if any. */
  held(operation: OperationState): Promise<string | undefined>;
  /** Strata saw restoring it conflict: never offer to restore it again. */
  markRestoreConflicted(hash: string): Promise<void>;
  /** The user kept it, or applied it: Strata owes it no restore. */
  keep(hash: string): Promise<void>;
}

/** The graph a flow works on (implemented by GraphController). */
export interface FlowHost extends RunnerHost {
  readonly ui: Ui;
  readonly runner: OpRunner;
  /** The refs the graph shows, which its menus were built from. */
  readonly refs: RefSnapshot;
  /** The stash list the graph shows, as last read. */
  readonly stashes: readonly StashEntry[];
  readonly lastUndo: Undo | undefined;
  settings(): FlowSettings;
  /** Reloads the graph; `focus` is selected and revealed once it has loaded. */
  refresh(focus?: string): Promise<void>;
  /** Reports a result in the status bar and to screen readers. */
  done(message: string): void;
  setUndo(undo: Undo | undefined): void;
  readonly leftovers: Leftovers;
  /** Selects and opens a stash (or commit) row, loading history to find it. */
  reveal(hash: string): void;
}

/** What a confirmation described: `rev` still points at `hash` (undefined: does not exist) when the operation starts. */
export interface Expect {
  rev: string;
  hash: string | undefined;
  /** As sentences name it: a quoted branch, or HEAD. */
  name: string;
  /** What to say when it no longer holds; changedMeanwhile(name) when absent. */
  changed?: string;
}

const resolve = (host: FlowHost, rev: string) =>
  runGit(host.git, host.cwd, ['rev-parse', '--verify', '--quiet', rev]).then(
    (s) => s.trim(),
    () => undefined,
  );

/**
 * Runs `steps` as one operation (`remote`: cancellable, with network progress). Throws Outdated,
 * having run nothing, when an `expect` no longer holds. Resolves undefined when it did not run
 * (busy, or cancelled).
 */
export function run<T>(
  host: FlowHost,
  label: string,
  steps: (exec: Exec) => Promise<T>,
  opts: { remote?: boolean; expect?: readonly Expect[] } = {},
) {
  return host.runner.run(host, label, opts.remote ?? false, async (exec) => {
    for (const e of opts.expect ?? [])
      if ((await resolve(host, e.rev)) !== e.hash) throw new Outdated(e.changed ?? changedMeanwhile(e.name));
    host.setUndo(undefined);
    return steps(exec);
  });
}

/** After an operation succeeded: reload the graph at `focus`, report, and offer Undo. */
export async function finish(host: FlowHost, r: { message: string; focus?: string; undo?: Undo }): Promise<void> {
  await host.refresh(r.focus);
  host.setUndo(r.undo);
  host.done(r.message);
  const undo = r.undo;
  if (undo)
    notify(host, 'info', r.message, ['Undo'], async () => {
      // A newer operation replaced this one's Undo.
      if (host.lastUndo === undo) await undoLast(host);
    });
}

/** Where failures are shown: a graph (which refresh when what it showed is outdated), or just the Ui. */
type Presenter = Pick<FlowHost, 'ui' | 'runner'> & { refresh?: () => Promise<void> };

/** A non-modal message; `then` runs with the action clicked, if any. */
export function notify(
  host: Presenter,
  level: 'info' | 'warning' | 'error',
  message: string,
  actions: string[],
  then: (action: string) => Promise<void> | void,
): void {
  host.ui.notify(level, message, ...actions).then(
    async (choice) => {
      try {
        if (choice !== undefined) await then(choice);
      } catch (e) {
        await fail(host, e);
      }
    },
    () => undefined,
  );
}

/** Types the git command of `op` into a new terminal in `cwd`, for the user to run there. */
export function typeInTerminal(host: Pick<FlowHost, 'ui'>, op: Operation, cwd: string): void {
  const line = shellCommand(['git', ...argv(op)], shellKind(vscode.env.shell));
  // Typed or pasted, a line the shell splits differently would run other commands.
  if (line === undefined) {
    void host.ui.notify('info', commandUnquotable(commandLine(op)));
    return;
  }
  const terminal = vscode.window.createTerminal({ name: 'Strata git', cwd });
  terminal.show();
  // Typed, not run: the user sees what will run and presses Enter.
  terminal.sendText(line, false);
}

/**
 * Shows why an operation failed. `remote` names the remote operation, for a failed sign-in;
 * `rerun`: the command that ran it, when `op` is only its first step.
 */
export async function fail(
  host: Presenter,
  e: unknown,
  remote?: { name: string | undefined; op: Operation; cwd: string; rerun?: string },
): Promise<void> {
  if (e instanceof Outdated) {
    void host.ui.notify('error', e.message);
    await host.refresh?.();
    return;
  }
  if (e instanceof GitOpError && remote && (e.kind === 'auth' || e.kind === 'hostKey')) {
    const choice = await host.ui.confirm(signInConfirmation(remote.name, e.kind, remote.rerun));
    if (choice === 'terminal') typeInTerminal(host, remote.op, remote.cwd);
    else if (choice === 'output') host.runner.showOutput();
    return;
  }
  const message = e instanceof GitOpError ? gitFailure(e.message) : e instanceof Error ? e.message : String(e);
  notify(host, 'error', message, e instanceof GitOpError ? ['Show Output'] : [], () => {
    host.runner.showOutput();
  });
}

/** The ref HEAD is on, as an Undo guard names it. */
export const headRef = (branch: string | undefined): string => (branch === undefined ? 'HEAD' : `refs/heads/${branch}`);

export async function undoLast(host: FlowHost): Promise<void> {
  const undo = host.lastUndo;
  if (!undo) return;
  if (undo.repo !== host.cwd) {
    host.setUndo(undefined);
    return;
  }
  let expect: readonly Expect[];
  if (undo.guard.kind === 'head') {
    const g = undo.guard;
    const head = await readHead(host.git, host.cwd);
    const name = head.branch === undefined ? 'HEAD' : quote(head.branch);
    // Never move another branch than the one the operation moved.
    if (headRef(head.branch) !== g.ref) {
      host.setUndo(undefined);
      notify(host, 'error', undoGone(undo.label, name), [], () => undefined);
      return;
    }
    if (head.hash !== g.after) {
      const [now, back] = await Promise.all([
        readCommit(host.git, host.cwd, head.hash),
        readCommit(host.git, host.cwd, g.before),
      ]);
      const ask = undoMovedConfirmation(head.branch, undo.label, now.short, back.short, g.deletes);
      if (!(await host.ui.confirm(ask))) return;
    }
    expect = [{ rev: 'HEAD', hash: head.hash, name }];
  } else expect = undo.guard.expect;
  const ran = await run(
    host,
    undoLabel(undo.label),
    async (exec) => {
      for (const op of undo.inverse) await exec(op);
      return true;
    },
    { expect },
  );
  if (ran) await finish(host, { message: undone(undo.label), ...(undo.focus ? { focus: undo.focus } : {}) });
}
