import * as vscode from 'vscode';
import { GraphPanel } from './host/panel.ts';

/** Returned from `activate`; consumed only by integration tests. */
export interface StrataTestApi {
  /** Opens (or reveals) the graph panel. */
  show(): GraphPanel;
  /** The open panel, including one VS Code restored. */
  current(): GraphPanel | undefined;
}

export function activate(context: vscode.ExtensionContext): StrataTestApi {
  const show = () => GraphPanel.show(context.extensionUri);
  context.subscriptions.push(
    vscode.commands.registerCommand('strata.show', show),
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
  return { show, current: () => GraphPanel.current };
}

export function deactivate(): void {
  GraphPanel.current?.dispose();
}
