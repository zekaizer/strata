import type { FromWorker, ToWorker } from '../shared/protocol.ts';

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

export function request(worker: Worker, msg: ToWorker, timeoutMs = 5000): Promise<FromWorker> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('worker timeout'));
    }, timeoutMs);
    worker.addEventListener(
      'message',
      (e: MessageEvent<FromWorker>) => {
        clearTimeout(timer);
        resolve(e.data);
      },
      { once: true },
    );
    worker.postMessage(msg);
  });
}
