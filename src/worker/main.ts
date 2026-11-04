import type { FromWorker } from '../shared/protocol.ts';

function post(m: FromWorker): void {
  postMessage(m);
}

addEventListener('message', () => {
  post({ type: 'pong' });
});
