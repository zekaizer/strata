import * as vscode from 'vscode';
import { registerCommands } from './host/menus.ts';
import { GraphPanel } from './host/panel.ts';

/** Returned from `activate`; consumed only by integration tests. */
export interface StrataTestApi {
  /** Opens (or reveals) the graph panel. */
  show(): GraphPanel;
  /** The open panel, including one VS Code restored. */
  current(): GraphPanel | undefined;
}

/** Time for VS Code to revive the graph through the serializer before a tab without it counts as orphaned. */
const ORPHAN_CHECK_MS = 3000;

export function activate(context: vscode.ExtensionContext): StrataTestApi {
  GraphPanel.memento = context.workspaceState;
  const show = () => GraphPanel.show(context.extensionUri);
  context.subscriptions.push(
    vscode.commands.registerCommand('strata.show', show),
    ...registerCommands(),
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
  return { show, current: () => GraphPanel.current };
}

export function deactivate(): void {
  GraphPanel.current?.dispose();
}
