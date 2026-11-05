import * as vscode from 'vscode';

/**
 * Context keys Strata owns. `strata.head`: 'tracking' (on a branch with an upstream), 'branch'
 * (on one without), 'detached', or '' without a repository. `strata.repositories`: how many
 * repositories VS Code has open.
 */
export type ContextKey = 'strata.busy' | 'strata.canUndo' | 'strata.operation' | 'strata.head' | 'strata.repositories';

const values = new Map<ContextKey, unknown>();

/** Sets a context key for when-clauses; the last value is kept for integration tests. */
export async function setContext(key: ContextKey, value: boolean | string | number): Promise<void> {
  values.set(key, value);
  await vscode.commands.executeCommand('setContext', key, value);
}

export const contextValue = (key: ContextKey): unknown => values.get(key);
