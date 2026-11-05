import * as vscode from 'vscode';
import { setContext } from './context.ts';
import type { FlowEnv } from './flow.ts';
import { GraphPanel } from './panel.ts';
import { repoList, type RepoList } from './repositories.ts';

/** Sits right of the Source Control items (status.scm, priority 10000) on the left. */
const STATUS_PRIORITY = 9999;

/** Opens (or reveals) the graph showing the repository at `root`, or the one it would show anyway. */
export async function openGraph(extensionUri: vscode.Uri, root?: string): Promise<GraphPanel> {
  const panel = GraphPanel.show(extensionUri);
  if (root !== undefined) await panel.showRepository(root);
  return panel;
}

/**
 * The repository a Source Control menu was opened on: VS Code passes the provider's SourceControl,
 * whose rootUri is the repository's. Anything else (the Command Palette) names none.
 */
async function rootOfScmArg(arg: unknown): Promise<string | undefined> {
  const uri = typeof arg === 'object' && arg !== null ? (arg as { rootUri?: unknown }).rootUri : undefined;
  if (!(uri instanceof vscode.Uri)) return undefined;
  return (await repoList()).keyOf(uri);
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

/** Shown while a repository is open; clicking it shows the active editor's repository, if any. */
function statusBarItem(list: RepoList): vscode.Disposable {
  const item = vscode.window.createStatusBarItem('strata.graph', vscode.StatusBarAlignment.Left, STATUS_PRIORITY);
  item.name = 'Strata Commit Graph';
  item.text = '$(strata-graph) Graph';
  item.tooltip = 'Show Commit Graph';
  item.command = 'strata.showActive';
  statusBar = item;
  const sync = () => {
    void setContext('strata.repositories', list.api.repositories.length);
    if (list.api.repositories.length > 0) item.show();
    else item.hide();
  };
  sync();
  return vscode.Disposable.from(item, list.onDidChange(sync));
}

let statusBar: vscode.StatusBarItem | undefined;

/** The status bar item, for integration tests. */
export const graphStatusBarItem = (): vscode.StatusBarItem | undefined => statusBar;

/** The ways into the graph: Show Commit Graph, the Source Control menus, the status bar and Switch Repository. */
export function registerEntryPoints(extensionUri: vscode.Uri, env: FlowEnv): vscode.Disposable {
  const subscriptions: vscode.Disposable[] = [
    // From the Source Control title bar VS Code passes the provider clicked.
    vscode.commands.registerCommand('strata.show', async (arg: unknown) =>
      openGraph(extensionUri, await rootOfScmArg(arg)),
    ),
    vscode.commands.registerCommand('strata.openInGraph', async (arg: unknown) => {
      await openGraph(extensionUri, await rootOfScmArg(arg));
    }),
    vscode.commands.registerCommand('strata.showActive', async () => {
      await openGraph(extensionUri, (await repoList()).active());
    }),
    vscode.commands.registerCommand('strata.switchRepository', () => switchRepository(extensionUri, env)),
  ];
  void repoList().then(
    (list) => {
      subscriptions.push(statusBarItem(list));
    },
    () => undefined,
  );
  return new vscode.Disposable(() => {
    for (const d of subscriptions.splice(0)) d.dispose();
  });
}
