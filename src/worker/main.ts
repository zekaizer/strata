import { initialLaneState, layoutPage, type LaneState } from '../core/layout.ts';
import { LANE_HUES } from '../core/palette.ts';
import type { FromWorker, ToWorker } from '../shared/protocol.ts';

function post(m: FromWorker): void {
  postMessage(m);
}

let run = -1;
let state: LaneState = initialLaneState();

addEventListener('message', (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.type) {
    case 'ping':
      post({ type: 'pong' });
      break;
    case 'layout': {
      if (m.run !== run) {
        run = m.run;
        state = initialLaneState(m.head);
      }
      const page = layoutPage(state, m.commits, { colors: LANE_HUES.length });
      state = page.state;
      post({ type: 'rows', run, rows: page.rows, spans: page.spans, state });
      break;
    }
  }
});
