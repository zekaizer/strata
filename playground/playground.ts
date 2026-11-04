// Browser stand-in for the VS Code webview host: applies captured theme
// variables and fakes acquireVsCodeApi. Theme is chosen with ?theme=<kind>.
import type { HostToWebview, ThemeKind, WebviewToHost } from '../src/shared/protocol.ts';
import dark from './themes/dark.json';
import highContrastLight from './themes/high-contrast-light.json';
import highContrast from './themes/high-contrast.json';
import light from './themes/light.json';

const themes: Record<ThemeKind, Record<string, string>> = {
  dark,
  light,
  'high-contrast': highContrast,
  'high-contrast-light': highContrastLight,
};

const params = new URLSearchParams(location.search);
const theme = (params.get('theme') ?? 'dark') as ThemeKind;

for (const [k, v] of Object.entries(themes[theme])) document.documentElement.style.setProperty(k, v);
document.body.classList.add(
  theme === 'light' ? 'vscode-light' : theme === 'dark' ? 'vscode-dark' : 'vscode-high-contrast',
);

const toWebview = (m: HostToWebview) => {
  window.postMessage(m, '*');
};

/** Messages the webview sent; read by scripts/playground-shot.mjs. */
const sent: WebviewToHost[] = [];
Object.assign(window, { __strataSent: sent });

Object.assign(window, {
  acquireVsCodeApi: () => {
    let state: unknown;
    return {
      postMessage(m: WebviewToHost) {
        sent.push(m);
        console.debug('[webview → host]', m);
        if (m.type === 'ready') toWebview({ type: 'init', theme });
      },
      getState: () => state,
      setState: (s: unknown) => {
        state = s;
      },
    };
  },
});
