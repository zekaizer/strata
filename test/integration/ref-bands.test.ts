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
      assert.ok(band.bandBottom > 0 && band.bandBottom <= band.subjectTop + 1, `row ${i}: band above the subject`);
      assert.ok(Math.abs(band.bandLeft - band.subjectLeft) <= 1, `row ${i}: band starts at the subject column`);
      assert.ok(s.rowHeights[Number(i)]! > ROW_HEIGHT, `row ${i}: taller than a plain row`);
    }
    const plain = Object.keys(s.rowHeights)
      .map(Number)
      .filter((i) => !banded.includes(i));
    assert.ok(plain.length > 0);
    for (const i of plain) assert.equal(s.rowHeights[i], ROW_HEIGHT, `row ${i}: plain rows keep their height`);
  });

  it('stacks rows by their own heights', async () => {
    const s = await panel.probe();
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
      await panel.simulate({ kind: 'scrollToRow', index: 8 });
      const scrolled = await waitFor('scrolled to row 8', async () => {
        const s = await panel.probe();
        return s.scrollTop > 0 && s.rowTops[8] === s.scrollTop && s;
      });
      assert.equal(scrolled.refBands[2], undefined, 'row 2 has no refs yet');
      git('tag', tag, order()[2]!);
      const s = await refresh();
      assert.ok(s.refBands[2] !== undefined || s.rowTops[2] === undefined, 'row 2 got a band');
      assert.equal(s.rowTops[8], s.scrollTop, 'row 8 is still the first row in view');
    } finally {
      git('tag', '-d', tag);
      await refresh();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('workbench.action.editorLayoutSingle');
      panel = (await strata()).show();
      await panel.whenReady();
    }
  });
});
