import * as vscode from 'vscode';
import { argv, type Operation } from '../core/operations.ts';
import { shellCommand } from '../core/shell.ts';
import { GitOpError, runGitOp } from '../git/op.ts';
import { setContext } from './context.ts';

/** What the runner needs from the graph it serves. */
export interface RunnerHost {
  readonly git: string;
  readonly cwd: string;
  /** Tells the graph an operation started (label) or ended (undefined). */
  busy(label: string | undefined): void;
}

/** Runs one Operation and resolves with its output; a flow may run several within one `run`. */
export type Exec = (op: Operation) => Promise<{ stdout: string; stderr: string }>;

/** A lock held by another git process (e.g. VS Code's autofetch) is retried once after this long. */
const LOCK_RETRY_MS = 300;

/**
 * Runs repository-changing operations one at a time, with progress, a log in the "Strata" output
 * channel and the `strata.busy` context key that disables write commands meanwhile.
 */
export class OpRunner implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel('Strata', { log: true });
  private running: string | undefined;

  /**
   * Runs `steps` under one progress indicator. Remote operations show a cancellable notification;
   * local ones a status bar spinner (stopping a rebase halfway is worse than letting it finish).
   * Resolves undefined when another operation is running or the user cancelled.
   */
  async run<T>(
    host: RunnerHost,
    label: string,
    remote: boolean,
    steps: (exec: Exec) => Promise<T>,
  ): Promise<T | undefined> {
    if (this.running !== undefined) {
      vscode.window.setStatusBarMessage(`Strata is busy: ${this.running}`, 4000);
      return undefined;
    }
    this.running = label;
    host.busy(label);
    await setContext('strata.busy', true);
    try {
      return await vscode.window.withProgress(
        {
          location: remote ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window,
          title: `Strata: ${label}`,
          cancellable: remote,
        },
        async (progress, token) => {
          const abort = new AbortController();
          const sub = token.onCancellationRequested(() => {
            abort.abort();
          });
          try {
            return await steps((op) =>
              this.exec(host, op, abort.signal, (p) => {
                progress.report({ message: `${p.phase} ${p.percent}%` });
              }),
            );
          } finally {
            sub.dispose();
          }
        },
      );
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return undefined;
      throw e;
    } finally {
      this.running = undefined;
      host.busy(undefined);
      await setContext('strata.busy', false);
    }
  }

  private async exec(
    host: RunnerHost,
    op: Operation,
    signal: AbortSignal,
    onProgress: (p: { phase: string; percent: number }) => void,
  ): Promise<{ stdout: string; stderr: string }> {
    for (let attempt = 0; ; attempt++) {
      this.output.info(`> ${commandLine(op)}`);
      try {
        const { stdout, stderr } = await runGitOp(host.git, host.cwd, argv(op), { signal, onProgress });
        if (stderr.trim()) this.output.info(stderr.trim());
        return { stdout, stderr };
      } catch (e) {
        if (e instanceof GitOpError) {
          this.output.error([e.stdout.trim(), e.stderr.trim()].filter((s) => s !== '').join('\n') || e.message);
          if (e.kind === 'lock' && attempt === 0) {
            await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
            continue;
          }
        }
        throw e;
      }
    }
  }

  showOutput(): void {
    this.output.show(true);
  }

  dispose(): void {
    this.output.dispose();
  }
}

/** The operation as a POSIX shell command line. */
export const commandLine = (op: Operation): string => shellCommand(['git', ...argv(op)], 'posix');
