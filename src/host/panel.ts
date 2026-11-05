import * as vscode from 'vscode';
import type { HostToWebview, ProbeState, SimulatedAction, ThemeKind, WebviewToHost } from '../shared/protocol.ts';
import type { FileChange, FileView } from '../core/details.ts';
import type { Ref } from '../core/refs.ts';
import { GraphController, type SavedView } from './controller.ts';
import type { RepoSession } from './session.ts';
import type { FlowEnv, FlowHost } from './flow.ts';
import { isCommandId } from '../shared/commands.ts';
import { parseRepoKey, type RepoKey } from '../core/repos.ts';
import { repoList } from './repositories.ts';

export type ReadyInfo = Extract<WebviewToHost, { type: 'ready' }>;

export class GraphPanel implements vscode.Disposable {
  static readonly viewType = 'strata.graph';
  static current: GraphPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly messageEmitter = new vscode.EventEmitter<WebviewToHost>();
  /** Every message received from the webview. */
  readonly onDidReceiveMessage = this.messageEmitter.event;
  private readonly ready: Promise<ReadyInfo>;
  private controller: GraphController | undefined;
  /** A repository chosen before the controller started: it shows that one first. */
  private chosen: RepoKey | undefined;

  /** Where the webview's state is mirrored (workspace storage); set on activation. */
  static memento: vscode.Memento | undefined;
  /** The runner and Ui flows use; set on activation. */
  static env: FlowEnv | undefined;
  private static readonly stateKey = 'strata.graphState';

  static show(extensionUri: vscode.Uri, at: { column?: vscode.ViewColumn; initialState?: unknown } = {}): GraphPanel {
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal();
      return GraphPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      GraphPanel.viewType,
      'Commit Graph',
      at.column ?? vscode.ViewColumn.Active,
      GraphPanel.webviewOptions(extensionUri),
    );
    GraphPanel.current = new GraphPanel(panel, extensionUri, at.initialState);
    return GraphPanel.current;
  }

  /**
   * An extension host restart leaves the graph's webview open but cut off: VS Code neither
   * revives it nor hands it to the new host, so nothing answers it ("Loading…" forever). Such a
   * tab is replaced by a new panel in its place, with the state the old one mirrored here.
   * Runs after activation has had time to revive panels the normal way (window reloads).
   */
  static async replaceOrphan(extensionUri: vscode.Uri): Promise<void> {
    if (GraphPanel.current) return;
    const tab = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .find((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith(GraphPanel.viewType));
    if (!tab) return;
    const { group, isPinned, isActive } = tab;
    await vscode.window.tabGroups.close(tab, true);
    const initialState = GraphPanel.memento?.get(GraphPanel.stateKey);
    const panel = GraphPanel.show(extensionUri, { column: group.viewColumn, initialState });
    if (isPinned) {
      panel.panel.reveal(group.viewColumn, false);
      await vscode.commands.executeCommand('workbench.action.pinEditor');
    }
    if (!isActive && !isPinned) panel.panel.reveal(group.viewColumn, true);
  }

  /** Adopts a panel VS Code restored from the previous session. */
  static revive(panel: vscode.WebviewPanel, extensionUri: vscode.Uri): GraphPanel {
    panel.webview.options = GraphPanel.webviewOptions(extensionUri);
    GraphPanel.current?.dispose();
    GraphPanel.current = new GraphPanel(panel, extensionUri);
    return GraphPanel.current;
  }

  private static webviewOptions(extensionUri: vscode.Uri): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return {
      enableScripts: true,
      // Opening a diff hides the graph tab; keep its scroll position, selection and loaded history.
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')],
    };
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, initialState?: unknown) {
    this.panel = panel;
    this.ready = new Promise((resolve) => {
      const sub = this.onDidReceiveMessage((m) => {
        if (m.type !== 'ready') return;
        sub.dispose();
        resolve(m);
      });
    });
    panel.webview.html = renderHtml(panel.webview, vscode.Uri.joinPath(extensionUri, 'dist', 'webview'), initialState);
    this.disposables.push(
      panel.onDidDispose(() => {
        this.dispose();
      }),
      panel.webview.onDidReceiveMessage((m: WebviewToHost) => {
        this.onMessage(m);
      }),
      panel.onDidChangeViewState(() => {
        if (!panel.visible) this.post({ type: 'hidden' });
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        this.post({ type: 'init', theme: themeKind() });
      }),
      this.messageEmitter,
    );
  }

  openFile(
    hash: string,
    base: string | undefined,
    file: FileChange,
    view: FileView | 'primary',
    beside: boolean,
  ): Promise<void> {
    return this.session().openFileFromMenu(hash, base, file, view, beside);
  }

  absolutePath(path: string): string {
    return this.session().absolutePath(path);
  }

  shortHash(hash: string): Promise<string> {
    return this.session().shortHash(hash);
  }

  copyCommitPatch(hash: string): Promise<void> {
    return this.session().copyCommitPatch(hash);
  }

  /** Hides the badge of `ref` with a rule naming it. */
  hideBadge(ref: Ref): Promise<void> {
    return this.session().hideBadge(ref);
  }

  /** Opens the graph's ref filter searching for `search`. */
  findRefs(search: string): void {
    this.post({ type: 'findRefs', search });
  }

  copyStashPatch(hash: string): Promise<void> {
    return this.session().copyStashPatch(hash);
  }

  showStashes(): void {
    this.session().showStashes();
  }

  copyFilePatch(hash: string, base: string | undefined, file: FileChange): Promise<void> {
    return this.session().copyFilePatch(hash, base, file);
  }

  /** The shown repository, which a flow started now works on until it ends. */
  flowHost(): FlowHost {
    return this.session();
  }

  private session(): RepoSession {
    const s = this.controller?.shown;
    if (!s) throw new Error('the commit graph has not loaded a repository');
    return s;
  }

  /** Root of the repository shown. */
  shownRepository(): string | undefined {
    return this.controller?.shown?.key;
  }

  /**
   * Shows the repository whose root is `root`, as the user's choice. Resolves false, showing
   * nothing else, when no open repository has that root.
   */
  async showRepository(root: unknown): Promise<boolean> {
    const key = parseRepoKey(root, (await repoList()).keys());
    if (key === undefined) return false;
    if (this.controller) await this.controller.choose(key);
    else this.chosen = key;
    return true;
  }

  /** Writes a commit-graph for the shown repository and reloads. */
  writeCommitGraph(): Promise<void> {
    return this.controller?.shown?.writeCommitGraph() ?? Promise.resolve();
  }

  /** Resolves once the webview has booted. */
  whenReady(): Promise<ReadyInfo> {
    return this.ready;
  }

  /** Reads the `--vscode-*` theme variables currently applied in the webview. */
  readThemeVars(): Promise<Record<string, string>> {
    return this.request({ type: 'dumpThemeVars' }, 'themeVars').then((m) => m.vars);
  }

  /** Webview state, for integration tests. */
  probe(): Promise<ProbeState> {
    return this.request({ type: 'probe' }, 'probe').then((m) => m.state);
  }

  /** Makes the webview perform a UI action through DOM events, for integration tests. */
  async simulate(action: SimulatedAction): Promise<void> {
    await this.ready;
    this.post({ type: 'simulate', action });
  }

  private async request<T extends WebviewToHost['type']>(
    message: HostToWebview,
    reply: T,
    timeoutMs = 10_000,
  ): Promise<Extract<WebviewToHost, { type: T }>> {
    await this.ready;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        sub.dispose();
        reject(new Error(`webview did not answer ${message.type}`));
      }, timeoutMs);
      const sub = this.onDidReceiveMessage((m) => {
        if (m.type !== reply) return;
        clearTimeout(timer);
        sub.dispose();
        resolve(m as Extract<WebviewToHost, { type: T }>);
      });
      this.post(message);
    });
  }

  private onMessage(m: WebviewToHost): void {
    switch (m.type) {
      case 'ready':
        this.post({ type: 'init', theme: themeKind() });
        void this.startController(m);
        break;
      case 'error':
        void vscode.window.showErrorMessage(`Strata: ${m.message}`);
        break;
      case 'state':
        void GraphPanel.memento?.update(GraphPanel.stateKey, m.state);
        break;
      case 'themeVars':
      case 'probe':
        break;
      case 'menuCommand':
        // Only the graph's own commands, with the same validation as a menu click.
        if (isCommandId(m.command)) {
          void Promise.resolve(
            vscode.commands.executeCommand(m.command, { webview: GraphPanel.viewType, ...m.context }),
          ).then(undefined, (e: unknown) => {
            this.post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
          });
        }
        break;
      case 'refresh':
        // Also retries when the git API was not available at startup.
        if (this.controller) void this.controller.handle(m);
        else void this.startController(undefined);
        break;
      default:
        void this.controller?.handle(m);
    }
    this.messageEmitter.fire(m);
  }

  /** A reloaded webview (e.g. after being hidden) sends `ready` again and gets a fresh history. */
  private async startController(saved: SavedView | undefined): Promise<void> {
    try {
      const env = GraphPanel.env;
      if (!env) throw new Error('Strata is not activated');
      this.controller ??= new GraphController(
        await repoList(),
        (m) => {
          this.post(m);
        },
        env,
        (title) => {
          this.panel.title = title;
        },
      );
      const chosen = this.chosen;
      this.chosen = undefined;
      await this.controller.start(saved && { last: saved.last, views: saved.views, options: saved.options }, chosen);
    } catch (e) {
      this.post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  private post(m: HostToWebview): void {
    // Fails once the webview is disposed; replies to it no longer matter.
    try {
      this.panel.webview.postMessage(m).then(undefined, () => undefined);
    } catch {
      // disposed
    }
  }

  dispose(): void {
    if (GraphPanel.current === this) GraphPanel.current = undefined;
    this.controller?.dispose();
    for (const d of this.disposables.splice(0)) d.dispose();
    this.panel.dispose();
  }
}

function themeKind(): ThemeKind {
  switch (vscode.window.activeColorTheme.kind) {
    case vscode.ColorThemeKind.Light:
      return 'light';
    case vscode.ColorThemeKind.HighContrast:
      return 'high-contrast';
    case vscode.ColorThemeKind.HighContrastLight:
      return 'high-contrast-light';
    case vscode.ColorThemeKind.Dark:
      return 'dark';
  }
}

/** Escapes text for a double-quoted HTML attribute. */
const attribute = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function renderHtml(webview: vscode.Webview, root: vscode.Uri, initialState?: unknown): string {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const uri = (p: string) => webview.asWebviewUri(vscode.Uri.joinPath(root, p)).toString();
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
    // The worker is loaded from a blob: URL because webview resources are cross-origin to the document.
    `worker-src blob:`,
    `connect-src ${webview.cspSource}`,
  ].join('; ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri('codicons/codicon.css')}">
<link rel="stylesheet" href="${uri('style.css')}">
</head>
<body data-worker-src="${uri('worker.js')}"${
    initialState === undefined ? '' : ` data-initial-state="${attribute(JSON.stringify(initialState))}"`
  }>
<div id="app"></div>
<script nonce="${nonce}" src="${uri('main.js')}"></script>
</body>
</html>`;
}
