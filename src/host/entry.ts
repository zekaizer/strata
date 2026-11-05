import * as vscode from 'vscode';
import { setContext } from './context.ts';
import type { FlowEnv } from './flow.ts';
import { GraphPanel } from './panel.ts';
import { repoList, type RepoList } from './repositories.ts';

/** Opens (or reveals) the graph showing the repository at `root`, or the one it would show anyway. */
export async function openGraph(extensionUri: vscode.Uri, root?: string): Promise<GraphPanel> {
  const panel = GraphPanel.show(extensionUri);
  if (root !== undefined) await panel.showRepository(root);
  return panel;
}

/** Strata: Switch Repository...: picks one of the open repositories to show in the graph. */
async function switchRepository(extensionUri: vscode.Uri, env: FlowEnv): Promise<void> {
  const list = await repoList();
  const shown = GraphPanel.current?.shownRepository();
  const root = await env.ui.pick({
    title: 'Show Repository in Commit Graph',
    placeholder: 'Repository to show',
    items: list.items().map((r) => ({
      label: r.name,
      description: r.root === shown ? `${r.path} (shown)` : r.path,
      ...(r.head === undefined ? {} : { detail: `$(git-branch) ${r.head}` }),
      value: r.root,
    })),
  });
  if (root !== undefined) await openGraph(extensionUri, root);
}

function countRepositories(list: RepoList): vscode.Disposable {
  const count = () => {
    void setContext('strata.repositories', list.api.repositories.length);
  };
  count();
  return list.onDidChange(count);
}

/** The ways into the graph besides Show Commit Graph. */
export function registerEntryPoints(extensionUri: vscode.Uri, env: FlowEnv): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [
    vscode.commands.registerCommand('strata.switchRepository', () => switchRepository(extensionUri, env)),
  ];
  void repoList().then(
    (list) => {
      disposables.push(countRepositories(list));
    },
    () => undefined,
  );
  return [
    new vscode.Disposable(() => {
      for (const d of disposables.splice(0)) d.dispose();
    }),
  ];
}
