import * as vscode from 'vscode';
import type { AutostashSetting } from '../core/autostash.ts';
import type { Operation } from '../core/operations.ts';
import type { RefSnapshot } from '../core/refs.ts';
import {
  changedMeanwhile,
  gitFailure,
  signInConfirmation,
  undoLabel,
  undoMovedConfirmation,
  undone,
} from '../core/wording.ts';
import { readCommit } from '../git/facts.ts';
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

/** What Undo Last Operation runs. */
export interface Undo {
  /** What it undoes, as in "Undid the {label}": "merge", "branch deletion". */
  label: string;
  ops: Operation[];
  /** HEAD right after the operation, and where Undo moves it back to; Undo asks first when HEAD has moved since. */
  guard?: { head: string; back: string };
  /** The commit to select afterwards. */
  focus?: string;
}

/** What the extension gives every graph: the one runner, and the Ui (tests replace it). */
export interface FlowEnv {
  readonly runner: OpRunner;
  ui: Ui;
}

/** The graph a flow works on (implemented by GraphController). */
export interface FlowHost extends RunnerHost {
  readonly ui: Ui;
  readonly runner: OpRunner;
  /** The refs the graph shows, which its menus were built from. */
  readonly refs: RefSnapshot;
  readonly lastUndo: Undo | undefined;
  settings(): FlowSettings;
  /** Reloads the graph; `focus` is selected and revealed once it has loaded. */
  refresh(focus?: string): Promise<void>;
  /** Reports a result in the status bar and to screen readers. */
  done(message: string): void;
  setUndo(undo: Undo | undefined): void;
}

/** What a confirmation described: `rev` still points at `hash` when the operation starts. */
export interface Expect {
  rev: string;
  hash: string;
  /** As sentences name it: a quoted branch, or HEAD. */
  name: string;
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
      if ((await resolve(host, e.rev)) !== e.hash) throw new Outdated(changedMeanwhile(e.name));
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

/** Shows why an operation failed. `remote` names the remote operation, for a failed sign-in. */
export async function fail(
  host: Presenter,
  e: unknown,
  remote?: { name: string | undefined; op: Operation; cwd: string },
): Promise<void> {
  if (e instanceof Outdated) {
    void host.ui.notify('error', e.message);
    await host.refresh?.();
    return;
  }
  if (e instanceof GitOpError && remote && (e.kind === 'auth' || e.kind === 'hostKey')) {
    const choice = await host.ui.confirm(signInConfirmation(remote.name, e.kind));
    if (choice === 'terminal') {
      const terminal = vscode.window.createTerminal({ name: 'Strata git', cwd: remote.cwd });
      terminal.show();
      terminal.sendText(commandLine(remote.op));
    } else if (choice === 'output') host.runner.showOutput();
    return;
  }
  const message = e instanceof GitOpError ? gitFailure(e.message) : e instanceof Error ? e.message : String(e);
  notify(host, 'error', message, e instanceof GitOpError ? ['Show Output'] : [], () => {
    host.runner.showOutput();
  });
}

const head = (host: FlowHost) =>
  runGit(host.git, host.cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']).then((s) => s.trim());

export async function undoLast(host: FlowHost): Promise<void> {
  const undo = host.lastUndo;
  if (!undo) return;
  if (undo.guard && (await head(host)) !== undo.guard.head) {
    const [now, back] = await Promise.all([
      readCommit(host.git, host.cwd, 'HEAD'),
      readCommit(host.git, host.cwd, undo.guard.back),
    ]);
    const ask = undoMovedConfirmation(host.refs.headBranch, undo.label, now.short, back.short);
    if (!(await host.ui.confirm(ask))) return;
  }
  const ran = await run(host, undoLabel(undo.label), async (exec) => {
    for (const op of undo.ops) await exec(op);
    return true;
  });
  if (ran) await finish(host, { message: undone(undo.label), ...(undo.focus ? { focus: undo.focus } : {}) });
}
