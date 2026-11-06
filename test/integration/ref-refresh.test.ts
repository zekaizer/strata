import * as assert from 'node:assert/strict';
import type { GraphPanel } from '../../src/host/panel.ts';
import type { ProbeState } from '../../src/shared/protocol.ts';
import { commitMenu, flowSuite, reload, run } from './flow-helpers.ts';
import { git, waitFor } from './helpers.ts';

const hasBadge = (p: ProbeState, name: string) => Object.values(p.refBands).some((b) => b.badges.includes(name));

const isHeadBadge = (p: ProbeState, name: string) =>
  Object.values(p.refBands).some((b) => b.badges.some((text, i) => text === name && b.head[i]));

const shownHashes = (p: ProbeState) => Object.values(p.rowHashes);

/** The row at the top of the list and how far it is scrolled past. */
function topRow(p: ProbeState): { hash: string; offset: number } {
  const [index, top] = Object.entries(p.rowTops)
    .map(([i, t]) => [Number(i), t] as const)
    .find(([i, t]) => t <= p.scrollTop && p.scrollTop < t + (p.rowHeights[i] ?? 0))!;
  return { hash: p.rowHashes[index]!, offset: p.scrollTop - top };
}

/** Selects the row of `subject` with its details unfolded. */
async function unfold(panel: GraphPanel, subject: string): Promise<ProbeState> {
  const hash = git('log', '--all', '--format=%H', '--grep', `^${subject}$`);
  const shown = await waitFor('the history', async () => {
    const p = await panel.probe();
    return p.done && !p.restoring && p;
  });
  if (shown.detailsShown === hash) return shown;
  const index = Object.entries(shown.rowHashes).find(([, h]) => h === hash)![0];
  await panel.simulate({ kind: 'clickRow', index: Number(index) });
  return waitFor(`details of ${subject}`, async () => {
    const p = await panel.probe();
    return p.detailsShown === hash && p;
  });
}

describe('graph updates after ref changes', () => {
  const { panel, ui } = flowSuite();

  /** Runs `change` and waits until `shown` holds; the list must never have gone blank meanwhile. */
  async function across(change: () => unknown, shown: (p: ProbeState) => boolean, what: string) {
    const before = await panel().probe();
    await change();
    const after = await waitFor(what, async () => {
      const p = await panel().probe();
      return shown(p) && !p.restoring && p;
    });
    assert.equal(after.blankFrames, before.blankFrames, 'the list never went blank');
    return { before, after };
  }

  /** As `across`, and the history was not read again. */
  async function inPlace(change: () => unknown, shown: (p: ProbeState) => boolean, what: string) {
    const { before, after } = await across(change, shown, what);
    assert.equal(after.generation, before.generation, 'the history was not read again');
    assert.equal(after.commits, before.commits);
    assert.equal(after.scrollTop, before.scrollTop);
    return { before, after };
  }

  it('shows a branch made outside Strata without reading the history again', async () => {
    const s = await unfold(panel(), 'Search UI');
    const { after } = await inPlace(
      () => git('branch', 'outside', 'main~2'),
      (p) => hasBadge(p, 'outside'),
      'the new badge',
    );
    assert.equal(after.selected, s.selected);
    assert.equal(after.detailsShown, s.detailsShown);
  });

  it('creates a branch from the menu without reading the history again', async () => {
    const at = git('rev-parse', 'main~3');
    ui.type('from-menu');
    await inPlace(
      () => run('strata.createBranch', commitMenu(at)),
      (p) => isHeadBadge(p, 'from-menu') && p.selected === at,
      'the new branch, checked out and selected',
    );
  });

  it('renames and deletes a merged branch, and adds a tag, without reading the history again', async () => {
    const s = await unfold(panel(), 'Login form');
    await inPlace(
      () => git('branch', '-m', 'feature/login', 'feature/sign-in'),
      (p) => hasBadge(p, 'feature/sign-in') && !hasBadge(p, 'feature/login'),
      'the renamed badge',
    );
    await inPlace(
      () => git('branch', '-d', 'feature/sign-in'),
      (p) => !hasBadge(p, 'feature/sign-in'),
      'no badge',
    );
    const { after } = await inPlace(
      () => git('tag', 'v0.9', 'main~1'),
      (p) => hasBadge(p, 'v0.9'),
      'the tag',
    );
    assert.equal(after.detailsShown, s.detailsShown);
  });

  it('switches branches outside Strata without reading the history again', async () => {
    await inPlace(
      () => git('switch', '--quiet', 'feature/search'),
      (p) => isHeadBadge(p, 'feature/search'),
      'HEAD on feature/search',
    );
  });

  it('drops the commits of a deleted unmerged branch without going blank', async () => {
    const s = await unfold(panel(), 'Search UI');
    const gone = git('rev-parse', 'wip/experiment');
    const { after } = await across(
      () => git('branch', '-D', 'wip/experiment'),
      (p) => !shownHashes(p).includes(gone),
      'the unmerged commit gone',
    );
    assert.equal(after.selected, s.selected);
    assert.equal(after.detailsShown, s.detailsShown);
  });

  it('adds a commit made outside Strata, and replaces it when amended, without going blank', async () => {
    const s = await unfold(panel(), 'Search UI');
    const made = await across(
      () => git('commit', '--quiet', '--allow-empty', '-m', 'Made outside'),
      (p) => shownHashes(p).includes(git('rev-parse', 'HEAD')),
      'the new commit',
    );
    assert.equal(made.after.selected, s.selected);
    assert.equal(made.after.detailsShown, s.detailsShown);
    const old = git('rev-parse', 'HEAD');
    const amended = await across(
      () => git('commit', '--quiet', '--amend', '--allow-empty', '-m', 'Made outside, amended'),
      (p) => shownHashes(p).includes(git('rev-parse', 'HEAD')) && !shownHashes(p).includes(old),
      'the amended commit in place of the old one',
    );
    assert.equal(amended.after.detailsShown, s.detailsShown);
  });

  it('keeps the row at the top of a scrolled list when history above it changes', async () => {
    let tip = git('rev-parse', 'main');
    for (let i = 0; i < 120; i++) tip = git('commit-tree', '-p', tip, '-m', `Long ${i}`, `${tip}^{tree}`);
    git('branch', 'long', tip);
    await reload(panel());
    await waitFor('history', async () => (await panel().probe()).done);
    await panel().simulate({ kind: 'scrollToRow', index: 60 });
    const before = topRow(await panel().probe());
    const total = Number(git('rev-list', '--count', '--branches')) + 1;
    const { after } = await across(
      () => git('commit', '--quiet', '--allow-empty', '-m', 'Above the fold'),
      (p) => p.commits === total,
      'the new commit loaded',
    );
    assert.deepEqual(topRow(after), before);
  });

  it('keeps the selection and details across Refresh without going blank', async () => {
    const s = await unfold(panel(), 'Login validation');
    const { after } = await across(
      () => panel().simulate({ kind: 'click', selector: '.codicon-refresh' }),
      (p) => p.generation > s.generation,
      'the reloaded history',
    );
    assert.equal(after.selected, s.selected);
    assert.equal(after.detailsShown, s.detailsShown);
  });
});
