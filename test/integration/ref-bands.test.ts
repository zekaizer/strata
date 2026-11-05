import * as assert from 'node:assert/strict';
import type { GraphPanel } from '../../src/host/panel.ts';
import * as vscode from 'vscode';
import { git, strata, waitFor } from './helpers.ts';

const ROW_HEIGHT = 24;
const order = () => git('rev-list', '--topo-order', '--branches', '--remotes', 'HEAD').split('\n');

describe('ref badges', () => {
  let panel: GraphPanel;
  before(async () => {
    panel = (await strata()).show();
    await panel.whenReady();
    await waitFor('history', async () => (await panel.probe()).done);
  });
  after(() => {
    panel.dispose();
  });

  it('shows badges in a band above the subject, only on rows with refs', async () => {
    const s = await panel.probe();
    const banded = Object.keys(s.refBands).map(Number);
    assert.ok(banded.includes(0), 'the HEAD commit carries main');
    assert.ok(s.refBands[0]!.badges.includes('main'));
    for (const [i, band] of Object.entries(s.refBands)) {
      // The badges sit on the subject line's top edge: they may reach into the space above the
      // glyphs inside the text's line box, but not the glyphs (which start ~3px lower).
      assert.ok(band.badgeBottom > 0 && band.badgeBottom <= band.subjectTop + 2, `row ${i}: badges above the subject`);
      assert.ok(band.badgeBottom >= band.subjectTop - 1, `row ${i}: badges sit on the subject, not floating above`);
      assert.ok(Math.abs(band.bandLeft - band.subjectLeft) <= 1, `row ${i}: band starts at the subject column`);
      assert.ok(s.rowHeights[Number(i)]! > ROW_HEIGHT, `row ${i}: taller than a plain row`);
    }
    const plain = Object.keys(s.rowHeights)
      .map(Number)
      .filter((i) => !banded.includes(i));
    assert.ok(plain.length > 0);
    for (const i of plain) assert.equal(s.rowHeights[i], ROW_HEIGHT, `row ${i}: plain rows keep their height`);
  });

  it('keeps a banded row compact', async () => {
    const s = await panel.probe();
    for (const i of Object.keys(s.refBands).map(Number)) assert.equal(s.rowHeights[i], ROW_HEIGHT + 14, `row ${i}`);
  });

  it('dims the badges of rows that are not selected, except the current branch', async () => {
    await panel.simulate({ kind: 'key', key: 'Escape' });
    const s = await panel.probe();
    const sel = order().indexOf(s.selected ?? '');
    let checked = 0;
    for (const [i, band] of Object.entries(s.refBands)) {
      if (Number(i) === sel) continue;
      band.colors.forEach((c, k) => {
        const expected = band.head[k] ? band.subjectColor : band.authorColor;
        assert.equal(c, expected, `row ${i} badge ${band.badges[k]}`);
        checked++;
      });
    }
    assert.ok(checked > 1);
    assert.ok(
      Object.values(s.refBands).some((b) => b.head.includes(true)),
      'the current branch is on screen',
    );
  });

  it('shows the badges of the selected row at full tone', async () => {
    const s = await panel.probe();
    const index = Object.keys(s.refBands)
      .map(Number)
      .find((i) => i > 0 && !s.refBands[i]!.head.includes(true))!;
    await panel.simulate({ kind: 'clickRow', index });
    const t = await waitFor('selected', async () => {
      const p = await panel.probe();
      return p.selected === order()[index] && p.refBands[index] !== undefined && p;
    });
    const band = t.refBands[index]!;
    for (const c of band.colors) assert.equal(c, band.subjectColor);
  });

  it('stacks rows by their own heights', async () => {
    await panel.simulate({ kind: 'key', key: 'Escape' });
    const s = await waitFor('collapsed', async () => {
      const p = await panel.probe();
      return p.expandedHeight === 0 && p;
    });
    for (let i = 0; s.rowTops[i + 1] !== undefined; i++) {
      assert.equal(s.rowTops[i + 1], s.rowTops[i]! + s.rowHeights[i]!, `row ${i + 1}`);
    }
  });

  it('selects a row when its band is clicked', async () => {
    const s = await panel.probe();
    const index = Object.keys(s.refBands)
      .map(Number)
      .find((i) => i > 0)!;
    await panel.simulate({ kind: 'clickRow', index, y: 2 });
    await waitFor('band click selects its row', async () => (await panel.probe()).selected === order()[index]);
  });

  it('keeps the same rows in view when a refresh adds a ref above them', async () => {
    // A short list, so it can scroll: the graph on top, a document below.
    const doc = await vscode.workspace.openTextDocument({ content: 'below' });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    await vscode.commands.executeCommand('workbench.action.editorLayoutTwoRows');
    const tag = 'strata-test-band';
    const refresh = async () => {
      const before = (await panel.probe()).generation;
      await panel.simulate({ kind: 'click', selector: '.codicon-refresh' });
      return waitFor('reloaded', async () => {
        const s = await panel.probe();
        return s.generation > before && s.done && s.rowTops[8] !== undefined && s;
      });
    };
    try {
      await panel.simulate({ kind: 'key', key: 'Escape' });
      const scrolled = await waitFor('scrolled to row 8', async () => {
        // Again until the two-row layout has made the list short enough to scroll.
        await panel.simulate({ kind: 'scrollToRow', index: 8 });
        const s = await panel.probe();
        return s.scrollTop > 0 && s.rowTops[8] === s.scrollTop && s;
      });
      assert.equal(scrolled.refBands[2], undefined, 'row 2 has no refs yet');
      git('tag', tag, order()[2]!);
      const s = await refresh();
      assert.ok(s.refBands[2] !== undefined || s.rowTops[2] === undefined, 'row 2 got a band');
      assert.equal(s.rowTops[8], s.scrollTop, 'row 8 is still the first row in view');
    } finally {
      // Only if it was made: a failure before that must not be hidden by the cleanup.
      if (git('tag', '--list', tag)) git('tag', '-d', tag);
      await refresh();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('workbench.action.editorLayoutSingle');
      panel = (await strata()).show();
      await panel.whenReady();
    }
  });
});
