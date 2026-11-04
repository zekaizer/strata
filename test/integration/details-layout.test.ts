import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { GraphPanel } from '../../src/host/panel.ts';
import type { ProbeState } from '../../src/shared/protocol.ts';
import { git, strata, waitFor } from './helpers.ts';

const order = () => git('rev-list', '--topo-order', '--branches', '--remotes', 'HEAD').split('\n');
const IDENTITY = ['-c', 'user.name=Ada Lovelace', '-c', 'user.email=ada@example.com'];

describe('details layout', () => {
  let panel: GraphPanel;
  const longBranch = 'strata-long-body-test';

  async function reload(): Promise<ProbeState> {
    const before = (await panel.probe()).generation;
    await panel.simulate({ kind: 'click', selector: '.codicon-refresh' });
    return waitFor('reloaded', async () => {
      const s = await panel.probe();
      return s.generation > before && s.done && s;
    });
  }

  async function openDetails(index: number): Promise<NonNullable<ProbeState['details']>> {
    const hash = order()[index];
    const s0 = await panel.probe();
    if (s0.selected !== hash || !s0.details) await panel.simulate({ kind: 'clickRow', index });
    const s = await waitFor(`details of row ${index}`, async () => {
      const p = await panel.probe();
      return p.detailsShown === hash && p.details && p;
    });
    return s.details!;
  }

  before(async () => {
    panel = (await strata()).show();
    await panel.whenReady();
    await waitFor('history', async () => (await panel.probe()).done);
  });
  after(() => {
    panel.dispose();
  });

  it('puts the byline above the subject and the files after the message', async () => {
    const d = await openDetails(2);
    const at = (c: string) => d.blocks.findIndex((b) => b.split(' ').includes(c));
    assert.ok(at('byline') >= 0 && at('byline') < at('details-subject'), d.blocks.join(', '));
    assert.ok(at('details-subject') < at('files-summary'), d.blocks.join(', '));
    assert.ok(at('files-summary') < at('files'), d.blocks.join(', '));
    assert.match(d.byline, /Ada Lovelace/);
  });

  it('opens the meta table between the byline and the subject', async () => {
    const d = await openDetails(2);
    const at = (c: string) => d.blocks.findIndex((b) => b.split(' ').includes(c));
    assert.ok(at('byline') < at('meta-wrap') && at('meta-wrap') < at('details-subject'), d.blocks.join(', '));
  });

  it('decides side by side from the content, not from a fixed width', async () => {
    // "Add docs and sources": no body and a small tree, narrow enough to sit beside each other.
    const d = await openDetails(1);
    assert.ok(d.treeWidth >= 150 && d.treeWidth <= 480, `tree width ${d.treeWidth}`);
    assert.equal(d.stacked, !d.sideBySide);
    if (d.listWidth >= 900) assert.equal(d.sideBySide, true, `list ${d.listWidth}px, tree ${d.treeWidth}px`);
    // Opening the meta table changes the height only, never the arrangement.
    await panel.simulate({ kind: 'click', selector: '.byline-toggle' });
    const open = await waitFor('meta open', async () => {
      const p = await panel.probe();
      return p.details?.metaOpen && p.details;
    });
    assert.equal(open.sideBySide, d.sideBySide);
    await panel.simulate({ kind: 'click', selector: '.byline-toggle' });
    await waitFor('meta closed', async () => (await panel.probe()).details?.metaOpen === false);
  });

  it('keeps Old | diff | New next to the file names', async () => {
    const d = await openDetails(1);
    assert.ok(d.actionsRight > 0, 'actions laid out');
    assert.ok(d.actionsRight <= d.cols * d.treeWidth + (d.cols - 1) * 24 + 1, `${d.actionsRight} vs ${d.treeWidth}`);
  });

  it('copies the full hash when the hash is clicked', async () => {
    await openDetails(2);
    await vscode.env.clipboard.writeText('');
    await panel.simulate({ kind: 'click', selector: '.byline-hash' });
    await waitFor('copied', async () => (await vscode.env.clipboard.readText()) === order()[2]);
    const s = await waitFor('announced', async () => {
      const p = await panel.probe();
      return p.announced === 'Copied full commit hash' && p;
    });
    assert.match(s.details!.byline, /Copied/);
  });

  it('unfolds the meta table and keeps it unfolded for other commits', async () => {
    await openDetails(2);
    await panel.simulate({ kind: 'click', selector: '.byline-toggle' });
    const d = (await waitFor('meta open', async () => (await panel.probe()).details?.metaOpen && (await panel.probe())))
      .details!;
    assert.deepEqual(d.metaRows.slice(0, 2), ['Commit', 'Author']);
    // Row 2 is "Merge cross/x and cross/y": two parents, labelled in order.
    assert.ok(d.metaRows.includes('1st parent') && d.metaRows.includes('2nd parent'), d.metaRows.join(', '));
    const next = await openDetails(1);
    assert.equal(next.metaOpen, true);
    assert.ok(next.metaRows.includes('Parent'), next.metaRows.join(', '));
    await panel.simulate({ kind: 'click', selector: '.byline-toggle' });
    await waitFor('meta closed', async () => (await panel.probe()).details?.metaOpen === false);
  });

  it('names the base commit in the files summary', async () => {
    const single = await openDetails(1);
    assert.match(single.filesSummary, new RegExp(`· vs ${order()[2]!.slice(0, 7)}$`));
    const merge = await openDetails(2);
    assert.match(merge.filesSummary, / · vs first parent [0-9a-f]{7}$/);
  });

  it('clamps a long body with a line count and expands it in place', async () => {
    const body = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of a long explanation.`).join('\n');
    const tip = git(...IDENTITY, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', `Long body\n\n${body}`);
    git('update-ref', `refs/heads/${longBranch}`, tip);
    try {
      await reload();
      const index = order().indexOf(tip);
      const d = await openDetails(index);
      assert.equal(d.bodyClamp.clamped, true);
      assert.ok(d.bodyClamp.hiddenLines >= 2, String(d.bodyClamp.hiddenLines));
      await panel.simulate({ kind: 'click', selector: '.details-more' });
      const open = await waitFor('expanded', async () => {
        const p = await panel.probe();
        return p.details && !p.details.bodyClamp.clamped && p.details;
      });
      assert.equal(open.moreBelow, open.overflowing, 'more-below follows the expanded body');
    } finally {
      git('update-ref', '-d', `refs/heads/${longBranch}`);
      await reload();
    }
  });

  it('keeps the more-below marker in step with the content while moving through commits', async () => {
    await openDetails(0);
    for (let i = 0; i < 6; i++) {
      await panel.simulate({ kind: 'key', key: 'ArrowDown' });
      const hash = order()[i + 1];
      const d = await waitFor(`details ${i + 1}`, async () => {
        const p = await panel.probe();
        return p.detailsShown === hash && p.details && p.details;
      });
      assert.equal(d.moreBelow, d.overflowing, `row ${i + 1}`);
    }
  });

  it('returns focus to the list on Escape from inside the details', async () => {
    await openDetails(2);
    await panel.simulate({ kind: 'focus', selector: '.byline-hash' });
    await panel.simulate({ kind: 'key', key: 'Escape', target: 'focused' });
    const s = await waitFor('list focused', async () => {
      const p = await panel.probe();
      return p.focused.split(' ').includes('scroller') && p;
    });
    assert.equal(s.selected, order()[2], 'the selection stays');
  });

  it('merges a branch and its same-named remote-tracking branch into one badge', async () => {
    git('remote', 'add', 'origin', 'https://example.com/origin.git');
    git('update-ref', 'refs/remotes/origin/main', 'main');
    try {
      const s = await reload();
      const band = s.refBands[0]!;
      assert.deepEqual(band.badges, ['main'], 'one badge');
      assert.deepEqual([...band.refNames].sort(), ['refs/heads/main', 'refs/remotes/origin/main']);
    } finally {
      git('update-ref', '-d', 'refs/remotes/origin/main');
      git('remote', 'remove', 'origin');
      await reload();
    }
  });
});
