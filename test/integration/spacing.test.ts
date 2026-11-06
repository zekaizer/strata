import * as assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphPanel } from '../../src/host/panel.ts';
import type { ProbeState } from '../../src/shared/protocol.ts';
import { commitMenu, run } from './flow-helpers.ts';
import { git, strata, waitFor, workspaceRoot } from './helpers.ts';

/** The same part of a surface keeps its spacing in every state of that surface. */
describe('spacing across states', () => {
  let panel: GraphPanel;
  const rowOf = (p: ProbeState, hash: string) =>
    Number(Object.entries(p.rowHashes).find(([, h]) => h === hash)?.[0] ?? -1);
  /** The gap above the first block whose class includes `cls`. */
  const gapAbove = (p: ProbeState, cls: string) => {
    const b = p.spacing.details.find((d) => d.block.split(' ').includes(cls));
    assert.ok(b, `${cls} in ${p.spacing.details.map((d) => d.block).join(', ')}`);
    return Math.round(b.gap);
  };

  async function openRow(hash: string): Promise<ProbeState> {
    const s = await panel.probe();
    if (s.selected !== hash || !s.details) await panel.simulate({ kind: 'clickRow', index: rowOf(s, hash) });
    return waitFor(`details of ${hash}`, async () => {
      const p = await panel.probe();
      return p.detailsShown === hash && p.details && p;
    });
  }

  async function toggleMeta(open: boolean): Promise<ProbeState> {
    await panel.simulate({ kind: 'click', selector: '.byline-toggle' });
    return waitFor(open ? 'meta open' : 'meta closed', async () => {
      const p = await panel.probe();
      return p.details?.metaOpen === open && p;
    });
  }

  before(async () => {
    panel = (await strata()).show();
    await panel.whenReady();
    await waitFor('history', async () => (await panel.probe()).done);
  });
  after(() => {
    git('checkout', '--', '.');
    panel.dispose();
  });

  it('keeps the subject as far from what is above it in every kind of details', async () => {
    const head = git('rev-parse', 'HEAD');
    const folded = gapAbove(await openRow(head), 'details-subject');
    const open = gapAbove(await toggleMeta(true), 'details-subject');
    await toggleMeta(false);
    assert.equal(open, folded, 'meta open and folded');

    await run('strata.editMessage', commitMenu(head));
    const editing = await waitFor('the editor', async () => {
      const p = await panel.probe();
      return p.editor?.shown && p;
    });
    assert.equal(gapAbove(editing, 'message-editor'), folded, 'the editor in place of the subject');
    await panel.simulate({ kind: 'click', selector: '.tidy-actions .button:not(.primary)' });
    await waitFor('the editor closed', async () => (await panel.probe()).editor === undefined);

    writeFileSync(join(workspaceRoot(), 'main.txt'), 'edited\n');
    await waitFor('changes row', async () => rowOf(await panel.probe(), 'changes') >= 0);
    const changes = await openRow('changes');
    assert.equal(gapAbove(changes, 'details-subject'), folded, 'uncommitted changes');
  });
});
