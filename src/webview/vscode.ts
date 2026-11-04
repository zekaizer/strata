import type { WebviewToHost } from '../shared/protocol.ts';

interface VsCodeApi {
  postMessage(message: WebviewToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** acquireVsCodeApi may be called only once per webview lifetime. */
export const vscode: VsCodeApi = acquireVsCodeApi();
