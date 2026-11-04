import * as vscode from 'vscode';
import { GraphPanel } from './host/panel.ts';

/** Returned from `activate`; consumed only by integration tests. */
export interface StrataTestApi {
  /** Opens (or reveals) the graph panel. */
  show(): GraphPanel;
}

export function activate(context: vscode.ExtensionContext): StrataTestApi {
  const show = () => GraphPanel.show(context.extensionUri);
  context.subscriptions.push(vscode.commands.registerCommand('strata.show', show));
  return { show };
}

export function deactivate(): void {
  GraphPanel.current?.dispose();
}
