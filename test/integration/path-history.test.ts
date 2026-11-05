import * as assert from 'node:assert/strict';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { GraphPanel } from '../../src/host/panel.ts';
import type { ProbeState } from '../../src/shared/protocol.ts';
import { menu, run } from './flow-helpers.ts';
import { git, strata, waitFor, workspaceRoot } from './helpers.ts';

const ALL = ['--branches', '--remotes', 'HEAD'];
const FILE = 'feature_search.txt';

/** Commits of the default view that change `path`, as git lists them. */
const changing = (path: string, ...extra: string[]) =>
  git('log', '--format=%H', ...extra, ...ALL, '--', path)
    .split('\n')
    .filter(Boolean);

describe('path history', () => {
  let panel: GraphPanel;
  const until = (what: string, test: (s: ProbeState) => boolean) =>
    waitFor(what, async () => {
      const s = await panel.probe();
      return test(s) && s;
    });
  /** Waits for a new history, read to its end, of exactly `paths` (null: the whole repository). */
  const history = async (paths: string[] | null, after: number) =>
    until(`history of ${String(paths)}`, (s) => {
      const shown = s.options.path?.paths ?? null;
      return s.generation > after && s.done && JSON.stringify(shown) === JSON.stringify(paths);
    });

  before(async () => {
    panel = (await strata()).show();
    await panel.whenReady();
    await until('initial history', (s) => s.done);
  });
  after(() => {
    panel.dispose();
  });

  it('shows the history of a file picked in the Explorer, ref tips dimmed', async () => {
    const gen = (await panel.probe()).generation;
    const uri = vscode.Uri.file(join(workspaceRoot(), FILE));
    // What the Explorer passes: the clicked file and the selection.
    await run('strata.showHistory', uri);
    const s = await history([FILE], gen);
    const want = changing(FILE);
    const shown = new Set(Object.values(s.rowHashes));
    for (const h of want) assert.ok(shown.has(h), `row of ${h}`);
    assert.equal(s.pathChip, FILE);
    assert.match(s.status, new RegExp(`^${want.length} commits change ${FILE}$`));
    // main's tip leaves the file alone: kept for its badge, dimmed.
    const main = git('rev-parse', 'main');
    const mainRow = Number(Object.entries(s.rowHashes).find(([, h]) => h === main)?.[0]);
    assert.ok(s.unchangedRows.includes(mainRow), 'main tip dimmed');
    assert.match(s.rowLabels[main] ?? '', /no change to feature_search\.txt/);
  });

  it('combines with first parent', async () => {
    const gen = (await panel.probe()).generation;
    await panel.simulate({ kind: 'click', selector: '.first-parent-button' });
    const s = await until('first-parent path history', (p) => p.generation > gen && p.done && p.options.firstParent);
    assert.equal(s.options.path?.paths[0], FILE);
    // The file changed only on feature/search: on main's first-parent line its merge brought the change.
    const merge = git('log', '--format=%H', '--first-parent', '--grep=Merge branch feature/search', 'main');
    assert.ok(Object.values(s.rowHashes).includes(merge), 'the merge that brought the change');
    const gen2 = s.generation;
    await panel.simulate({ kind: 'click', selector: '.first-parent-button' });
    await until('first parent off', (p) => p.generation > gen2 && p.done && !p.options.firstParent);
  });

  it('shows the parent folder of a changed file from the details menu', async () => {
    const gen = (await panel.probe()).generation;
    const docs = git('log', '-1', '--format=%H', '--', 'docs/guide/intro.md');
    await run(
      'strata.file.showFolderHistory',
      menu({ webviewSection: 'file', strataHash: docs, strataPath: 'docs/guide/intro.md', strataStatus: 'A' }),
    );
    const s = await history(['docs/guide/'], gen);
    assert.equal(s.pathChip, 'guide/');
  });

  it('shows the whole history again with the chip', async () => {
    const gen = (await panel.probe()).generation;
    await panel.simulate({ kind: 'click', selector: '.path-chip-clear' });
    const s = await history(null, gen);
    assert.equal(s.pathChip, '');
    assert.equal(s.commits, Number(git('rev-list', '--count', ...ALL)));
  });

  it('shows the whole history for the repository root', async () => {
    await run('strata.showHistory', vscode.Uri.file(join(workspaceRoot(), FILE)));
    await until('a path history', (p) => p.options.path !== null && p.done);
    const gen = (await panel.probe()).generation;
    await run('strata.showHistory', vscode.Uri.file(workspaceRoot()));
    await history(null, gen);
  });
});
