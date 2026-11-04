import { initialLaneState, layoutPage, type LaneState } from '../core/layout.ts';
import { LANE_HUES } from '../core/palette.ts';
import type { FromWorker, ToWorker } from '../shared/protocol.ts';

function post(m: FromWorker): void {
  postMessage(m);
}

let generation = -1;
let state: LaneState = initialLaneState();

addEventListener('message', (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.type) {
    case 'ping':
      post({ type: 'pong' });
      break;
    case 'layout': {
      // Pages of one generation arrive in order; a new generation restarts the layout.
      if (m.generation !== generation) {
        generation = m.generation;
        state = initialLaneState();
      }
      const page = layoutPage(state, m.commits, { colors: LANE_HUES.length });
      state = page.state;
      post({ type: 'rows', generation, rows: page.rows, spans: page.spans, state });
      break;
    }
  }
});
