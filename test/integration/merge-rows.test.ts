import * as assert from 'node:assert/strict';
import type { GraphPanel } from '../../src/host/panel.ts';
import type { ProbeState } from '../../src/shared/protocol.ts';
import { git, strata, waitFor } from './helpers.ts';

const ALL = ['--branches', '--remotes', 'HEAD'];

describe('merge rows', () => {
  let panel: GraphPanel;
  const merges = new Set(
    git('rev-list', '--merges', ...ALL)
      .split('\n')
      .filter(Boolean),
  );
  const until = (what: string, test: (s: ProbeState) => boolean) =>
    waitFor(what, async () => {
      const s = await panel.probe();
      return test(s) && s;
    });
  const mergeRows = (s: ProbeState) =>
    Object.entries(s.rowHashes)
      .filter(([, h]) => merges.has(h))
      .map(([i]) => Number(i));

  before(async () => {
    panel = (await strata()).show();
    await panel.whenReady();
    await until('history', (s) => s.done);
    await panel.simulate({ kind: 'key', key: 'Escape' });
  });
  after(() => {
    panel.dispose();
  });

  it('dims the subject of merge commits and of nothing else', async () => {
    const s = await panel.probe();
    const expected = mergeRows(s);
    assert.ok(expected.length > 0, 'merges rendered');
    assert.deepEqual(s.dimmedRows, expected);
  });

  it('shows a selected merge in the selection colors', async () => {
    const row = mergeRows(await panel.probe())[0]!;
    await panel.simulate({ kind: 'clickRow', index: row });
    const s = await until('merge selected', (p) => p.selected === p.rowHashes[row]);
    assert.ok(!s.dimmedRows.includes(row), 'selected merge not dimmed');
    assert.ok(s.dimmedRows.length > 0, 'other merges still dimmed');
  });

  it('dims nothing in first-parent history, where merges are the steps of the line', async () => {
    let gen = (await panel.probe()).generation;
    await panel.simulate({ kind: 'click', selector: '.first-parent-button' });
    const s = await until('first-parent history', (p) => p.generation > gen && p.options.firstParent && p.done);
    assert.ok(mergeRows(s).length > 0, 'merges rendered');
    assert.deepEqual(s.dimmedRows, []);
    gen = s.generation;
    await panel.simulate({ kind: 'click', selector: '.first-parent-button' });
    await until('full history', (p) => p.generation > gen && !p.options.firstParent && p.done);
  });

  it('dims merges in the find list', async () => {
    await panel.simulate({ kind: 'click', selector: '.find-button' });
    await until('find open', (p) => p.find.open);
    await panel.simulate({ kind: 'type', selector: '.find-input', text: 'merge' });
    const hits = git('rev-list', '-i', '-F', '--grep=merge', ...ALL).split('\n');
    assert.ok(
      hits.some((h) => !merges.has(h)),
      'a match that is not a merge',
    );
    await until('matches counted', (p) => p.find.done && p.find.matches === hits.length);
    await panel.simulate({ kind: 'click', selector: '.find-toggle' });
    const s = await until('list shown', (p) => p.find.list !== undefined);
    const subjects = hits.filter((h) => merges.has(h)).map((h) => git('log', '-1', '--format=%s', h));
    assert.deepEqual(s.dimmedListRows, subjects);
    await panel.simulate({ kind: 'click', selector: '.find-toggle' });
    await panel.simulate({ kind: 'key', key: 'Escape', target: 'focused' });
    await until('find closed', (p) => !p.find.open);
  });
});
