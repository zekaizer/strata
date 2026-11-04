import * as vscode from 'vscode';
import type {
  HostToWebview,
  ProbeState,
  SimulatedAction,
  ThemeKind,
  ViewOptions,
  WebviewToHost,
} from '../shared/protocol.ts';
import type { FileChange, FileView } from '../core/details.ts';
import { GraphController } from './controller.ts';
import { isMenuCommand } from '../shared/menu-commands.ts';
import { getGitApi } from './git-api.ts';

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

  static show(extensionUri: vscode.Uri): GraphPanel {
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal();
      return GraphPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      GraphPanel.viewType,
      'Commit Graph',
      vscode.ViewColumn.Active,
      GraphPanel.webviewOptions(extensionUri),
    );
    GraphPanel.current = new GraphPanel(panel, extensionUri);
    return GraphPanel.current;
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

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.ready = new Promise((resolve) => {
      const sub = this.onDidReceiveMessage((m) => {
        if (m.type !== 'ready') return;
        sub.dispose();
        resolve(m);
      });
    });
    panel.webview.html = renderHtml(panel.webview, vscode.Uri.joinPath(extensionUri, 'dist', 'webview'));
    this.disposables.push(
      panel.onDidDispose(() => {
        this.dispose();
      }),
      panel.webview.onDidReceiveMessage((m: WebviewToHost) => {
        this.onMessage(m);
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
    return this.requireController().openFileFromMenu(hash, base, file, view, beside);
  }

  absolutePath(path: string): string {
    return this.requireController().absolutePath(path);
  }

  shortHash(hash: string): Promise<string> {
    return this.requireController().shortHash(hash);
  }

  private requireController(): GraphController {
    if (!this.controller) throw new Error('the commit graph has not loaded a repository');
    return this.controller;
  }

  /** Writes a commit-graph for the shown repository and reloads. */
  writeCommitGraph(): Promise<void> {
    return this.controller?.writeCommitGraph() ?? Promise.resolve();
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
        void this.startController(m.options);
        break;
      case 'error':
        void vscode.window.showErrorMessage(`Strata: ${m.message}`);
        break;
      case 'themeVars':
      case 'probe':
        break;
      case 'menuCommand':
        // Only the graph's own menu commands, with the same validation as a menu click.
        if (isMenuCommand(m.command)) {
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
  private async startController(options: ViewOptions | undefined): Promise<void> {
    try {
      this.controller ??= new GraphController(await getGitApi(), (m) => {
        this.post(m);
      });
      await this.controller.start(options);
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

function renderHtml(webview: vscode.Webview, root: vscode.Uri): string {
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
<body data-worker-src="${uri('worker.js')}">
<div id="app"></div>
<script nonce="${nonce}" src="${uri('main.js')}"></script>
</body>
</html>`;
}
