import type { HostToWebview } from '../shared/protocol.ts';
import { vscode } from './vscode.ts';
import { request, startWorker } from './worker-client.ts';

const app = document.getElementById('app')!;

window.addEventListener('message', (e: MessageEvent<HostToWebview>) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      document.body.dataset['theme'] = m.theme;
      break;
    case 'dumpThemeVars':
      vscode.postMessage({ type: 'themeVars', vars: readThemeVars() });
      break;
  }
});

/** VS Code injects theme colors as `--vscode-*` custom properties on <html>. */
function readThemeVars(): Record<string, string> {
  const style = document.documentElement.style;
  const vars: Record<string, string> = {};
  for (let i = 0; i < style.length; i++) {
    const name = style.item(i);
    if (name.startsWith('--vscode-')) vars[name] = style.getPropertyValue(name).trim();
  }
  return vars;
}

async function boot(): Promise<void> {
  app.innerHTML = '<div class="empty"><span class="codicon codicon-git-commit"></span> Strata</div>';
  let workerOk = false;
  try {
    const worker = await startWorker(document.body.dataset['workerSrc'] ?? '');
    await request(worker, { type: 'ping' });
    workerOk = true;
  } catch (err) {
    vscode.postMessage({ type: 'error', message: String(err) });
  }
  vscode.postMessage({ type: 'ready', workerOk });
}

void boot();
