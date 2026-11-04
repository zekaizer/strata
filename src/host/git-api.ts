import * as vscode from 'vscode';

// The subset of the built-in git extension's API (vscode.git, API version 1) Strata uses.
// Declared here instead of vendoring git.d.ts; field names follow that public API.

export interface GitRepositoryState {
  readonly HEAD: { readonly name?: string; readonly commit?: string } | undefined;
  readonly onDidChange: vscode.Event<void>;
}

export interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: GitRepositoryState;
}

export interface GitApi {
  readonly state: 'uninitialized' | 'initialized';
  readonly onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>;
  readonly git: { readonly path: string };
  readonly repositories: readonly GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
  getRepository(uri: vscode.Uri): GitRepository | null;
}

interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitApi;
}

/** Resolves the built-in git API once it has finished its initial repository scan. */
export async function getGitApi(): Promise<GitApi> {
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext) throw new Error('The built-in Git extension is not available.');
  const exports = ext.isActive ? ext.exports : await ext.activate();
  if (!exports.enabled) throw new Error('The built-in Git extension is disabled (git.enabled).');
  const api = exports.getAPI(1);
  if (api.state !== 'initialized') {
    await new Promise<void>((resolve) => {
      const sub = api.onDidChangeState((s) => {
        if (s !== 'initialized') return;
        sub.dispose();
        resolve();
      });
    });
  }
  return api;
}
