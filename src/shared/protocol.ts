// Message contract between the extension host and the webview.
// Both sides import this file; it must stay free of host- and DOM-only types.

export type ThemeKind = 'light' | 'dark' | 'high-contrast' | 'high-contrast-light';

export type HostToWebview = { type: 'init'; theme: ThemeKind } | { type: 'dumpThemeVars' };

export type WebviewToHost =
  | { type: 'ready'; workerOk: boolean }
  | { type: 'themeVars'; vars: Record<string, string> }
  | { type: 'error'; message: string };

/** Webview-to-worker messages. */
export type ToWorker = { type: 'ping' };

/** Worker-to-webview messages. */
export type FromWorker = { type: 'pong' };
