import { realpath } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import * as vscode from 'vscode';
import { parsePathFilter, parseRepoPath, type PathFilter, type RepoPath } from '../core/path-filter.ts';
import type { RepoKey } from '../core/repos.ts';
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

/** The file a command argument names: a URI, or a Source Control change (`resourceUri`). */
function uriOf(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  const uri = typeof arg === 'object' && arg !== null ? (arg as { resourceUri?: unknown }).resourceUri : undefined;
  return uri instanceof vscode.Uri ? uri : undefined;
}

/** A file of the working tree: a `git:` URI (a diff Strata or vscode.git opened) names one in its query. */
function workingFile(uri: vscode.Uri): vscode.Uri {
  if (uri.scheme !== 'git') return uri;
  try {
    const { path } = JSON.parse(uri.query) as { path?: unknown };
    return typeof path === 'string' ? vscode.Uri.file(path) : uri;
  } catch {
    return uri;
  }
}

/** `uri` relative to the repository at `root`: '' for the root itself, undefined outside it. */
async function repoPathOf(root: RepoKey, uri: vscode.Uri): Promise<RepoPath | '' | undefined> {
  // A workspace opened through a symbolic link names files by the link.
  const real = (p: string) => realpath(p).catch(() => p);
  const [base, file] = await Promise.all([real(root), real(uri.fsPath)]);
  const rel = relative(base, file).split(sep).join('/');
  if (rel === '') return '';
  if (rel.startsWith('../') || rel === '..') return undefined;
  const folder = await vscode.workspace.fs.stat(uri).then(
    (s) => (s.type & vscode.FileType.Directory) !== 0,
    // Deleted: a file whose history is still there.
    () => false,
  );
  return parseRepoPath(folder ? `${rel}/` : rel);
}

/**
 * Show History in Commit Graph: the history of the files and folders `args` name (Explorer passes
 * the clicked one and the selection; Source Control its changes), in the repository holding the
 * first. Its root shows the whole history.
 */
async function showHistory(extensionUri: vscode.Uri, args: unknown[]): Promise<void> {
  const uris = args.flatMap((a): unknown[] => (Array.isArray(a) ? (a as unknown[]) : [a])).map(uriOf);
  const files = uris.filter((u): u is vscode.Uri => u !== undefined).map(workingFile);
  const list = await repoList();
  const first = files[0];
  const key = first && list.keyOf(first);
  if (!first || key === undefined) {
    vscode.window.setStatusBarMessage('$(info) Strata: not in an open git repository', 5000);
    return;
  }
  const paths = await Promise.all(files.filter((u) => list.keyOf(u) === key).map((u) => repoPathOf(key, u)));
  const filter: PathFilter | null = paths.includes('')
    ? null
    : (parsePathFilter({ paths: paths.filter((p) => p !== undefined) }) ?? null);
  await GraphPanel.show(extensionUri).showPath(key, filter);
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

/**
 * The ways into the graph: Show Commit Graph, the Source Control menus, the status bar, Switch
 * Repository, and Show History from the Explorer, editors and Source Control changes.
 */
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
    vscode.commands.registerCommand('strata.showHistory', (...args: unknown[]) => showHistory(extensionUri, args)),
    // From the palette: the active editor's file.
    vscode.commands.registerCommand('strata.showFileHistory', (uri: unknown) =>
      showHistory(extensionUri, [uri ?? vscode.window.activeTextEditor?.document.uri]),
    ),
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
