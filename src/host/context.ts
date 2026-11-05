import * as vscode from 'vscode';

/** Context keys Strata owns. */
export type ContextKey = 'strata.busy' | 'strata.canUndo' | 'strata.operation';

const values = new Map<ContextKey, unknown>();

/** Sets a context key for when-clauses; the last value is kept for integration tests. */
export async function setContext(key: ContextKey, value: boolean | string): Promise<void> {
  values.set(key, value);
  await vscode.commands.executeCommand('setContext', key, value);
}

export const contextValue = (key: ContextKey): unknown => values.get(key);
