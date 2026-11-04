import type { WebviewToHost } from '../shared/protocol.ts';

interface VsCodeApi {
  postMessage(message: WebviewToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** acquireVsCodeApi may be called only once per webview lifetime. */
export const vscode: VsCodeApi = acquireVsCodeApi();

/**
 * The state saved by this webview, or for a new panel the one the host passed in (when it
 * re-creates a panel that an extension host restart left behind).
 */
export function savedState(): unknown {
  const own = vscode.getState();
  if (own !== undefined) return own;
  const passed = document.body.dataset['initialState'];
  if (!passed) return undefined;
  try {
    return JSON.parse(passed);
  } catch {
    return undefined;
  }
}
