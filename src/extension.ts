import * as vscode from 'vscode';
import { contextValue, type ContextKey } from './host/context.ts';
import type { FlowEnv } from './host/flow.ts';
import { registerCommands } from './host/menus.ts';
import { GraphPanel } from './host/panel.ts';
import { OpRunner } from './host/runner.ts';
import { vscodeUi, type Ui } from './host/ui.ts';

/** Returned from `activate`; consumed only by integration tests. */
export interface StrataTestApi {
  /** Opens (or reveals) the graph panel. */
  show(): GraphPanel;
  /** The open panel, including one VS Code restored. */
  current(): GraphPanel | undefined;
  /** Answers the questions flows ask; undefined restores VS Code's dialogs. */
  setUi(ui: Ui | undefined): void;
  /** The value Strata last gave a context key. */
  contextValue(key: ContextKey): unknown;
}

/** Time for VS Code to revive the graph through the serializer before a tab without it counts as orphaned. */
const ORPHAN_CHECK_MS = 3000;

export function activate(context: vscode.ExtensionContext): StrataTestApi {
  GraphPanel.memento = context.workspaceState;
  const runner = new OpRunner();
  const env: FlowEnv = { runner, ui: vscodeUi, state: context.workspaceState };
  GraphPanel.env = env;
  const show = () => GraphPanel.show(context.extensionUri);
  context.subscriptions.push(
    runner,
    vscode.commands.registerCommand('strata.show', show),
    ...registerCommands(env),
    vscode.commands.registerCommand('strata.writeCommitGraph', async () => {
      const panel = GraphPanel.current ?? show();
      await panel.whenReady();
      await panel.writeCommitGraph();
    }),
    // Reopens the graph after a restart when it was open; the webview restores its own position via setState.
    vscode.window.registerWebviewPanelSerializer(GraphPanel.viewType, {
      deserializeWebviewPanel: (panel) => {
        GraphPanel.revive(panel, context.extensionUri);
        return Promise.resolve();
      },
    }),
  );
  const orphanCheck = setTimeout(() => {
    void GraphPanel.replaceOrphan(context.extensionUri);
  }, ORPHAN_CHECK_MS);
  context.subscriptions.push({
    dispose: () => {
      clearTimeout(orphanCheck);
    },
  });
  return {
    show,
    current: () => GraphPanel.current,
    setUi: (ui) => {
      env.ui = ui ?? vscodeUi;
    },
    contextValue,
  };
}

export function deactivate(): void {
  GraphPanel.current?.dispose();
}
