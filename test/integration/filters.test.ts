import * as assert from 'node:assert/strict';
import type { GraphPanel } from '../../src/host/panel.ts';
import type { ProbeState } from '../../src/shared/protocol.ts';
import { git, strata, waitFor } from './helpers.ts';

const ALL = ['--branches', '--remotes', '--tags', 'HEAD'];
const count = (...args: string[]) => Number(git('rev-list', '--count', ...args));

describe('history filters', () => {
  let panel: GraphPanel;

  /** Waits until the webview has loaded and laid out exactly `n` commits under a new generation. */
  async function loaded(n: number, after: number, what: string): Promise<ProbeState> {
    return waitFor(what, async () => {
      const s = await panel.probe();
      return s.generation > after && s.done && s.commits === n && s.laidOut === n && s;
    });
  }

  before(async () => {
    panel = (await strata()).show();
    await panel.whenReady();
    await loaded(count(...ALL), -1, 'initial history');
  });
  after(() => {
    panel.dispose();
  });

  it('toggles first-parent history', async () => {
    let gen = (await panel.probe()).generation;
    await panel.simulate({ kind: 'click', selector: '.first-parent-button' });
    const s = await loaded(count('--first-parent', ...ALL), gen, 'first-parent history');
    assert.equal(s.options.firstParent, true);
    gen = s.generation;
    await panel.simulate({ kind: 'click', selector: '.first-parent-button' });
    await loaded(count(...ALL), gen, 'full history again');
  });

  it('limits history to refs picked in the filter', async () => {
    const gen = (await panel.probe()).generation;
    await panel.simulate({ kind: 'click', selector: '.ref-filter-button' });
    await panel.simulate({ kind: 'type', selector: '.popover-search', text: 'wip' });
    await panel.simulate({ kind: 'click', selector: 'input[data-ref="refs/heads/wip/experiment"]' });
    const s = await loaded(count('refs/heads/wip/experiment'), gen, 'filtered history');
    assert.deepEqual(s.options.refs, ['refs/heads/wip/experiment']);
  });

  it('combines a ref filter with first-parent', async () => {
    const gen = (await panel.probe()).generation;
    await panel.simulate({ kind: 'click', selector: '.first-parent-button' });
    await loaded(count('--first-parent', 'refs/heads/wip/experiment'), gen, 'filtered first-parent history');
    await panel.simulate({ kind: 'click', selector: '.first-parent-button' });
  });

  it('shows everything again with "Show all"', async () => {
    await waitFor('first-parent off', async () => !(await panel.probe()).options.firstParent);
    const gen = (await panel.probe()).generation;
    await panel.simulate({ kind: 'type', selector: '.popover-search', text: '' });
    await panel.simulate({ kind: 'click', selector: '.popover-all' });
    const s = await loaded(count(...ALL), gen, 'full history');
    assert.equal(s.options.refs, null);
  });
});
