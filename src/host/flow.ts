import * as vscode from 'vscode';
import type { AutostashSetting } from '../core/autostash.ts';
import { argv, type Operation } from '../core/operations.ts';
import type { RefSnapshot } from '../core/refs.ts';
import type { BadgeRuleStore } from './badge-store.ts';
import type { OperationState } from '../core/repo-state.ts';
import type { StashEntry } from '../core/stash.ts';
import { shellCommand, shellKind } from '../core/shell.ts';
import {
  changedMeanwhile,
  commandUnquotable,
  failedDuring,
  gitFailure,
  refName,
  signInConfirmation,
  UNDO_STALE,
  undoGone,
  undoLabel,
  undoMovedConfirmation,
  undone,
} from '../core/wording.ts';
import { countCommits, readCommit, readHead } from '../git/facts.ts';
import { GitOpError } from '../git/op.ts';
import { runGit } from '../git/run.ts';
import { commandLine, type Exec, type OpRunner, type RunnerHost } from './runner.ts';
import { Outdated } from './target.ts';
import type { Ui } from './ui.ts';
import type { MessageDraft } from '../shared/protocol.ts';

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
   * `deletes` names a branch Undo deletes (create branch). `refs`: refs that must still be where
   * the operation left them; HEAD's own only when Undo leaves its tree as it is (an in-place
   * rewrite), since update-ref does not touch the work tree.
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
  readonly badgeRules: BadgeRuleStore;
  /** The Undo of the last operation in each repository, by RepoKey. */
  readonly undos: Map<string, Undo>;
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

/** The repository a flow works on, as the graph showed it when the flow started (a RepoSession). */
export interface FlowHost extends RunnerHost {
  readonly ui: Ui;
  readonly runner: OpRunner;
  /** The refs the graph shows, which its menus were built from. */
  readonly refs: RefSnapshot;
  /** The stash list the graph shows, as last read. */
  readonly stashes: readonly StashEntry[];
  readonly lastUndo: Undo | undefined;
  settings(): FlowSettings;
  /**
   * Reloads the graph after an operation, marking what it moved; `focus` is selected and revealed
   * once it has loaded. `notified`: a notification says how the operation ended, so the graph does not.
   */
  refresh(focus?: string, notified?: boolean): Promise<void>;
  /** Reports a result in the status bar and to screen readers. */
  done(message: string): void;
  setUndo(undo: Undo | undefined): void;
  readonly leftovers: Leftovers;
  /**
   * Selects and opens a stash (or commit) row, loading history to find it. `against`: the commit
   * its files are compared with instead of its first parent.
   */
  reveal(hash: string, against?: string): void;
  /** A folder on the machine the repository is on, by the path git prints. */
  folderUri(path: string): vscode.Uri;
  /** Opens the inline message editor in the graph. */
  openEditor(draft: MessageDraft): void;
  /** Tells the message editor opened at HEAD `head` what saving rewrites (rewriteEffects). */
  editEffects(head: string, effects: string): void;
  /** Tells the message editor how its Save ended: applied closes it. */
  editEnded(applied: boolean): void;
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
    try {
      return await steps(exec);
    } catch (e) {
      // The innermost run names the failure: an undo or a retry runs inside the operation's own.
      if (e instanceof GitOpError && !DURING.has(e)) DURING.set(e, label);
      throw e;
    }
  });
}

/** The progress label of the operation each git failure happened in, for fail(). */
const DURING = new WeakMap<GitOpError, string>();

/** What to offer after an operation, besides Undo (Push after a Pull that a rejected push started). */
export interface Next {
  action: string;
  run: () => Promise<void>;
}

/**
 * After an operation succeeded: reload the graph at `focus`, report, and offer Undo and `next` in
 * a notification. `quiet`: an operation that leaves history as it was (create or rename a branch
 * or tag) reports in the status bar only; Undo Last Operation still undoes it.
 */
export async function finish(
  host: FlowHost,
  r: { message: string; focus?: string; undo?: Undo; next?: Next; quiet?: boolean },
): Promise<void> {
  await host.refresh(r.focus);
  host.setUndo(r.undo);
  host.done(r.message);
  const { next } = r;
  const undo = r.quiet ? undefined : r.undo;
  if (undo || next)
    notify(host, 'info', r.message, [...(undo ? ['Undo'] : []), ...(next ? [next.action] : [])], (a) =>
      a === 'Undo' && undo ? undoIfLatest(host, undo) : next?.run(),
    );
}

/**
 * After an operation ran but left something to settle (stashed changes that did not come back):
 * reload the graph at `focus` and show `warning` alone, with `actions` and Undo when it has one.
 */
export async function finishWithWarning(
  host: FlowHost,
  r: { warning: string; focus?: string; undo?: Undo },
  actions: string[],
  then: (action: string) => Promise<void> | void,
): Promise<void> {
  await host.refresh(r.focus);
  host.setUndo(r.undo);
  warnWithUndo(host, r.warning, r.undo, actions, then);
}

/** A warning about an operation that finished (finishWithWarning), with Undo when it has one. */
export function warnWithUndo(
  host: FlowHost,
  warning: string,
  undo: Undo | undefined,
  actions: string[],
  then: (action: string) => Promise<void> | void,
): void {
  notify(host, 'warning', warning, [...actions, ...(undo ? ['Undo'] : [])], (a) =>
    a === 'Undo' && undo ? undoIfLatest(host, undo) : then(a),
  );
}

async function undoIfLatest(host: FlowHost, undo: Undo): Promise<void> {
  if (host.lastUndo === undo) await undoLast(host);
  else void host.ui.notify('info', UNDO_STALE);
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
    void host.ui.notify('info', e.message);
    await host.refresh?.();
    return;
  }
  if (e instanceof GitOpError && remote && (e.kind === 'auth' || e.kind === 'hostKey')) {
    const choice = await host.ui.confirm(signInConfirmation(remote.name, e.kind, remote.rerun));
    if (choice === 'terminal') typeInTerminal(host, remote.op, remote.cwd);
    else if (choice === 'output') host.runner.showOutput();
    return;
  }
  const during = e instanceof GitOpError ? DURING.get(e) : undefined;
  const message =
    e instanceof GitOpError
      ? during === undefined
        ? gitFailure(e.message)
        : failedDuring(during, gitFailure(e.message))
      : e instanceof Error
        ? e.message
        : String(e);
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
    const name = head.branch === undefined ? 'HEAD' : refName(head.branch);
    // Never move another branch than the one the operation moved.
    if (headRef(head.branch) !== g.ref) {
      host.setUndo(undefined);
      notify(host, 'info', undoGone(undo.label, name), [], () => undefined);
      return;
    }
    if (head.hash !== g.after) {
      const [now, back, newer] = await Promise.all([
        readCommit(host.git, host.cwd, head.hash),
        readCommit(host.git, host.cwd, g.before),
        countCommits(host.git, host.cwd, [`${g.after}..${head.hash}`]),
      ]);
      const ask = undoMovedConfirmation(head.branch, undo.label, newer, now, back.short);
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
