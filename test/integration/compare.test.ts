import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { flowSuite, menu, reload, run } from './flow-helpers.ts';
import { git, waitFor } from './helpers.ts';

describe('compare with the selected commit', () => {
  const { panel, ui } = flowSuite();
  const order = () => git('rev-list', '--topo-order', '--branches', '--remotes', 'HEAD').split('\n');
  const bySubject = (subject: string) =>
    git('log', '--all', '--format=%H', '--fixed-strings', `--grep=${subject}`, '-n1');
  const file = 'feature_search.txt';

  /** Selects `subject`'s row (its details open); resolves its commit. */
  const select = async (subject: string) => {
    const hash = bySubject(subject);
    if ((await panel().probe()).detailsShown !== hash) {
      await panel().simulate({ kind: 'clickRow', index: order().indexOf(hash) });
      await waitFor(`details of ${subject}`, async () => (await panel().probe()).detailsShown === hash);
    }
    return hash;
  };
  /** Runs the menu command on `target`'s row as the graph wrote its context; resolves the probe once shown. */
  const compare = async (target: string) => {
    const ctx = (await panel().probe()).menuContexts.rows[target];
    assert.ok(ctx, 'the row is rendered');
    await run('strata.commit.compareWithSelected', menu(ctx));
    return waitFor('the comparison', async () => {
      const p = await panel().probe();
      return p.detailsShown === target && p.filesSummary?.includes('Show Own Changes') === true && p;
    });
  };

  it('names the selected commit in the menu context of every other commit row, and in none with several selected', async () => {
    const selected = await select('Search index');
    const rows = (await panel().probe()).menuContexts.rows;
    assert.equal(rows[selected]?.['strataCompareWith'], '');
    const others = Object.entries(rows).filter(([hash]) => hash !== selected);
    assert.ok(others.length > 0);
    for (const [, ctx] of others) assert.equal(ctx['strataCompareWith'], selected);

    const head = order().indexOf(git('rev-parse', 'HEAD'));
    await panel().simulate({ kind: 'clickRow', index: head });
    await panel().simulate({ kind: 'clickRow', index: order().indexOf(git('rev-parse', 'HEAD~1')), shiftKey: true });
    const p = await waitFor('two selected', async () => {
      const s = await panel().probe();
      return s.selection.length === 2 && s;
    });
    for (const ctx of Object.values(p.menuContexts.rows))
      assert.ok(ctx['webviewSection'] === 'selection' || ctx['strataCompareWith'] === '');
  });

  it('shows the commit the menu was opened on against the selected one, and its files open as that diff', async () => {
    const selected = await select('Search index');
    const target = bySubject('Search ranking');
    const p = await compare(target);
    assert.equal(p.selected, target);
    const differing = git('diff', '--name-only', '--no-renames', selected, target).split('\n');
    assert.deepEqual(p.menuContexts.files.map((f) => f['strataPath']).sort(), differing.sort());
    const count = differing.length === 1 ? '1 file' : `${differing.length} files`;
    assert.equal(p.filesSummary, `${count} changed · vs ${selected.slice(0, 7)} · Show Own Changes`);
    const ctx = p.menuContexts.files.find((f) => f['strataPath'] === file);
    assert.ok(ctx, `${file} differs between the two`);
    assert.deepEqual([ctx['strataHash'], ctx['strataBase'], ctx['strataCompared']], [target, selected, true]);

    const before = vscode.window.tabGroups.activeTabGroup.activeTab;
    await run('strata.file.openChanges', menu(ctx));
    const input = await waitFor('diff tab', () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      return tab !== before && tab?.input;
    });
    assert.ok(input instanceof vscode.TabInputTextDiff);
    const text = async (uri: vscode.Uri) => (await vscode.workspace.openTextDocument(uri)).getText();
    assert.equal(await text(input.original), git('show', `${selected}:${file}`) + '\n');
    assert.equal(await text(input.modified), git('show', `${target}:${file}`) + '\n');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  it('lists every file that differs between two commits far apart', async () => {
    const selected = await select('Unmerged experiment');
    const target = git('rev-parse', 'HEAD');
    const p = await compare(target);
    const differing = git('diff', '--name-only', '--no-renames', selected, target).split('\n');
    assert.ok(differing.length > 1);
    assert.deepEqual(p.menuContexts.files.map((f) => f['strataPath']).sort(), differing.sort());
    assert.match(
      p.filesSummary ?? '',
      new RegExp(`^${differing.length} files changed · vs ${selected.slice(0, 7)} · `),
    );
  });

  it('goes back to the commit against its parent with Show Own Changes, and with the link to the other commit', async () => {
    const selected = await select('Search index');
    const target = bySubject('Search ranking');
    await compare(target);
    await panel().simulate({ kind: 'click', selector: '.files-summary .link-button:last-child' });
    const own = await waitFor('its own changes', async () => {
      const p = await panel().probe();
      return p.detailsShown === target && p.filesSummary?.includes('Show Own Changes') === false && p;
    });
    assert.equal(own.filesSummary, `1 file changed · vs ${git('rev-parse', `${target}^`).slice(0, 7)}`);
    assert.equal(own.menuContexts.files[0]?.['strataCompared'], false);

    await select('Search index');
    await compare(target);
    await panel().simulate({ kind: 'click', selector: '.files-summary .files-base' });
    const other = await waitFor('the other commit', async () => {
      const p = await panel().probe();
      return p.detailsShown === selected && p;
    });
    assert.doesNotMatch(other.filesSummary ?? '', /Show Own Changes/);
  });

  it('keeps the comparison across a refresh', async () => {
    const selected = await select('Search index');
    const target = bySubject('Search ranking');
    const shown = (await compare(target)).filesSummary;
    await reload(panel());
    const p = await waitFor('details again', async () => {
      const s = await panel().probe();
      return s.detailsShown === target && s;
    });
    assert.equal(p.filesSummary, shown);
    assert.equal(p.menuContexts.files[0]?.['strataBase'], selected);
  });

  it('refuses a context that names no commit to compare with, and says why', async () => {
    const target = bySubject('Search ranking');
    const shown = await select('Search index');
    for (const strataCompareWith of ['', '--output=x', undefined]) {
      ui.clear();
      await run(
        'strata.commit.compareWithSelected',
        menu({ webviewSection: 'commit', strataHash: target, strataCompareWith }),
      );
      assert.deepEqual(ui.asked, [{ kind: 'notify', level: 'error', message: 'invalid commit id', actions: [] }]);
    }
    assert.equal((await panel().probe()).detailsShown, shown);
  });
});
