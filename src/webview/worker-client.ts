import type { FromWorker } from '../shared/protocol.ts';

/**
 * Starts the layout worker from a blob: URL. Webview resource URLs are
 * cross-origin to the webview document, so `new Worker(url)` is rejected.
 */
export async function startWorker(src: string): Promise<Worker> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`worker fetch failed: ${res.status}`);
  const blob = new Blob([await res.text()], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  try {
    return new Worker(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Round-trips a ping to prove the worker runs. */
export function ping(worker: Worker, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.removeEventListener('message', onMessage);
      reject(new Error('worker did not answer'));
    }, timeoutMs);
    const onMessage = (e: MessageEvent<FromWorker>) => {
      if (e.data.type !== 'pong') return;
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      resolve();
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({ type: 'ping' });
  });
}
