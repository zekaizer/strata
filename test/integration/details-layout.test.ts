import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { GraphPanel } from '../../src/host/panel.ts';
import type { ProbeState } from '../../src/shared/protocol.ts';
import { delay, git, strata, waitFor } from './helpers.ts';

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

  it('puts the message and the files side by side when the list has room', async () => {
    const d = await openDetails(1);
    assert.ok(d.treeWidth >= 150, `tree width ${d.treeWidth}`);
    assert.equal(d.stacked, !d.sideBySide);
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

  it('puts the files at the same place for every commit', async () => {
    // Commits 1 and 2 differ in subject, body and tree; the split may only follow the list width.
    // The graph column only grows as lanes come into view, so look once both rows have been shown.
    await openDetails(2);
    const a = await openDetails(1);
    const b = await openDetails(2);
    assert.equal(a.graphWidth, b.graphWidth, 'same list geometry');
    assert.equal(a.sideBySide, b.sideBySide);
    assert.ok(Math.abs(a.filesLeft - b.filesLeft) <= 1, `files at ${a.filesLeft}px and ${b.filesLeft}px`);
  });

  it('keeps Old | diff | New next to the file names', async () => {
    const d = await openDetails(1);
    assert.ok(d.actionsRight > 0, 'actions laid out');
    assert.ok(d.actionsRight <= d.cols * d.treeWidth + (d.cols - 1) * 24 + 1, `${d.actionsRight} vs ${d.treeWidth}`);
  });

  it('outlines the selected row only while the list is used with the keyboard', async () => {
    await panel.simulate({ kind: 'clickRow', index: 3 });
    const clicked = await waitFor('selected by click', async () => {
      const p = await panel.probe();
      return p.selected === order()[3] && p;
    });
    assert.equal(clicked.selectionOutline, 'none', 'a click leaves no focus outline behind');
    await panel.simulate({ kind: 'clickRow', index: 3 });
    await waitFor('folded', async () => (await panel.probe()).expandedHeight === 0);
    const folded = await panel.probe();
    assert.equal(folded.selectionOutline, 'none', 'nor does folding');
    assert.equal(folded.selectionShown, false, 'a closed commit is not drawn as selected');
    assert.equal(folded.selected, order()[3], 'but stays where the keys continue from');
    await panel.simulate({ kind: 'key', key: 'ArrowDown' });
    const keyed = await waitFor('moved by key', async () => {
      const p = await panel.probe();
      return p.selected === order()[4] && p;
    });
    assert.equal(keyed.selectionOutline, 'solid', 'keyboard navigation shows where focus is');
  });

  it('shows Old | diff | New only where the pointer or keyboard focus is', async () => {
    await openDetails(1);
    const active = () => vscode.window.tabGroups.activeTabGroup.activeTab;
    const graphLabel = active()?.label;
    await panel.simulate({ kind: 'clickFile', index: 0 });
    // Close the file's tab, not the graph: wait until it is the active one (tabs compare by label;
    // VS Code may hand out new Tab objects).
    const fileTab = await waitFor('file tab', () => active()?.label !== graphLabel && active()?.label);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await waitFor('file tab closed', () =>
      vscode.window.tabGroups.all.every((g) => g.tabs.every((t) => t.label !== fileTab)),
    );
    await panel.simulate({ kind: 'focus', selector: '.scroller' });
    const s = await panel.probe();
    assert.equal(s.idleFileActions, false, 'a clicked file keeps no buttons');
  });

  it('folds with the fold button without touching the row under the pointer', async () => {
    await openDetails(2);
    await panel.simulate({ kind: 'click', selector: '.details-fold' });
    const s = await waitFor('folded', async () => {
      const p = await panel.probe();
      return p.expandedHeight === 0 && p;
    });
    assert.equal(s.selected, order()[2], 'the same commit stays selected');
    await delay(300);
    assert.equal((await panel.probe()).expandedHeight, 0, 'and nothing else unfolded');
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
    // Author and committer always both, even when they are the same person.
    assert.deepEqual(d.metaRows.slice(0, 3), ['Commit', 'Author', 'Committer']);
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

  it('shows a long body in full beside the files, and folds it to a few lines above them', async () => {
    const body = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of a long explanation.`).join('\n');
    const tip = git(...IDENTITY, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', `Long body\n\n${body}`);
    git('update-ref', `refs/heads/${longBranch}`, tip);
    try {
      await reload();
      const index = order().indexOf(tip);
      // Beside the files the body needs no folding: the details scroll.
      const first = await openDetails(index);
      // Folded exactly when the files are below the message (the window may be narrow already).
      assert.equal(first.bodyClamp.clamped, first.stacked, `list ${first.listWidth}px, stacked ${first.stacked}`);
      if (!first.stacked)
        assert.ok(!first.blocks.includes('link-button details-more'), 'no Show more beside the files');
      // Narrow (an editor beside the graph): the files are below, so the body folds to keep them close.
      const doc = await vscode.workspace.openTextDocument({ content: 'beside' });
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
      await vscode.commands.executeCommand('workbench.action.evenEditorWidths');
      const narrow = await waitFor('stacked', async () => {
        const p = await panel.probe();
        return p.details?.stacked && p.details.bodyClamp.clamped && p.details;
      });
      assert.ok(narrow.bodyClamp.hiddenLines >= 2, String(narrow.bodyClamp.hiddenLines));
      await panel.simulate({ kind: 'click', selector: '.details-more' });
      const open = await waitFor('expanded', async () => {
        const p = await panel.probe();
        return p.details && !p.details.bodyClamp.clamped && p.details;
      });
      assert.equal(open.moreBelow, open.overflowing, 'more-below follows the expanded body');
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      panel = (await strata()).show();
      await panel.whenReady();
      git('update-ref', '-d', `refs/heads/${longBranch}`);
      await reload();
    }
  });

  it('gives the body 80 columns beside the files, and the full width above them', async () => {
    // A kernel-style body: prose filled to 72 columns, tab-indented code up to 79.
    const body = [
      "The module loader doesn't check for bounds of the ELF section index here.",
      '',
      '\tfor (i = 1; i < symsec->sh_size / sizeof(Elf_Sym); i++) {',
      '\t\tconst char *name = info->strtab + sym[i].st_name;',
      '\t\t\t/* Divert to percpu allocation if a percpu variable. */',
      '',
      'Signed-off-by: Ada Lovelace <ada@example.com>',
    ].join('\n');
    const tip = git(...IDENTITY, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', `Kernel body\n\n${body}`);
    git('update-ref', `refs/heads/${longBranch}`, tip);
    const check = (d: NonNullable<ProbeState['details']>, where: string) => {
      const widths = `${where}: layout ${d.layoutWidth}px, message ${d.messageWidth}px, 80 columns ${d.bodyColumns80}px`;
      // Beside each other when 80 columns, the gap and the files' minimum fit.
      assert.equal(d.sideBySide, d.layoutWidth >= d.bodyColumns80 + 24 + 260, widths);
      if (!d.sideBySide) assert.ok(Math.abs(d.messageWidth - Math.min(d.layoutWidth, d.bodyColumns80)) <= 1, widths);
      // 80 columns whenever the layout has them, so a kernel-style body keeps its lines.
      assert.ok(d.messageWidth >= Math.min(d.layoutWidth, d.bodyColumns80) - 1, widths);
      if (d.layoutWidth >= d.bodyColumns80) assert.equal(d.bodyWraps, false, widths);
      return widths;
    };
    try {
      await reload();
      const index = order().indexOf(tip);
      // The window's own width decides which of the two this is (1.90 opens narrower).
      check(await openDetails(index), 'as opened');
      const doc = await vscode.workspace.openTextDocument({ content: 'beside' });
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
      await vscode.commands.executeCommand('workbench.action.evenEditorWidths');
      const narrow = await waitFor('stacked', async () => {
        const p = await panel.probe();
        return p.details?.stacked && p.details;
      });
      check(narrow, 'narrow');
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      panel = (await strata()).show();
      await panel.whenReady();
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
