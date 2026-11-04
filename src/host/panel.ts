import * as vscode from 'vscode';
import type { HostToWebview, ThemeKind, WebviewToHost } from '../shared/protocol.ts';

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

  static show(extensionUri: vscode.Uri): GraphPanel {
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal();
      return GraphPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(GraphPanel.viewType, 'Commit Graph', vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')],
    });
    GraphPanel.current = new GraphPanel(panel, extensionUri);
    return GraphPanel.current;
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

  /** Resolves once the webview has booted. */
  whenReady(): Promise<ReadyInfo> {
    return this.ready;
  }

  /** Reads the `--vscode-*` theme variables currently applied in the webview. */
  async readThemeVars(): Promise<Record<string, string>> {
    await this.ready;
    return new Promise((resolve) => {
      const sub = this.onDidReceiveMessage((m) => {
        if (m.type !== 'themeVars') return;
        sub.dispose();
        resolve(m.vars);
      });
      this.post({ type: 'dumpThemeVars' });
    });
  }

  private onMessage(m: WebviewToHost): void {
    switch (m.type) {
      case 'ready':
        this.post({ type: 'init', theme: themeKind() });
        break;
      case 'error':
        void vscode.window.showErrorMessage(`Strata: ${m.message}`);
        break;
      case 'themeVars':
        break;
    }
    this.messageEmitter.fire(m);
  }

  private post(m: HostToWebview): void {
    void this.panel.webview.postMessage(m);
  }

  dispose(): void {
    if (GraphPanel.current === this) GraphPanel.current = undefined;
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
