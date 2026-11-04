// Click-to-details latency in VS Code, run by `npm run perf:e2e` against STRATA_PERF_REPO.
import { performance } from 'node:perf_hooks';
import { strata, waitFor } from '../integration/helpers.ts';

describe('perf: details latency', function () {
  this.timeout(600_000);
  it('measures click to details, first and later', async () => {
    const api = await strata();
    const panel = api.show();
    await panel.whenReady();
    await waitFor('first page', async () => (await panel.probe()).laidOut >= 300, 300_000, 10);
    const times: number[] = [];
    for (const index of [5, 6, 7, 8, 9, 10]) {
      const t = performance.now();
      await panel.simulate({ kind: 'clickRow', index });
      await waitFor(
        'details',
        async () => {
          const s = await panel.probe();
          return s.detailsShown !== undefined && s.detailsShown === s.selected;
        },
        120_000,
        5,
      );
      times.push(Math.round(performance.now() - t));
    }
    console.log(`STRATA_PERF ${JSON.stringify({ clickToDetailsMs: times })}`);
    panel.dispose();
  });
});
