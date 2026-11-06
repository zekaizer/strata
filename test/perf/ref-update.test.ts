// Time from a ref or history change to the graph showing it, run by `npm run perf:e2e` against a
// scratch repository in STRATA_PERF_REPO (it creates branches and commits there). Prints results.
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import * as vscode from 'vscode';
import type { GraphPanel } from '../../src/host/panel.ts';
import type { ProbeState } from '../../src/shared/protocol.ts';
import { delay, strata, waitFor, workspaceRoot } from '../integration/helpers.ts';
import { ScriptedUi } from '../integration/scripted-ui.ts';

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: workspaceRoot(), encoding: 'utf8', stdio: 'pipe' }).trim();

const hasBadge = (p: ProbeState, name: string) => Object.values(p.refBands).some((b) => b.badges.includes(name));

interface Run {
  /** From the change to the graph showing it, and of that the change itself (git, a flow). */
  ms: number;
  changeMs: number;
  /** A probe saw no rows on screen. */
  blank: boolean;
  reread: boolean;
}

/** Times `change` until `shown`, probing every few ms for an empty list meanwhile. */
async function time(panel: GraphPanel, change: () => unknown, shown: (p: ProbeState) => boolean): Promise<Run> {
  const before = await panel.probe();
  const t = performance.now();
  await change();
  const changeMs = Math.round(performance.now() - t);
  let blank = false;
  for (;;) {
    const p = await panel.probe();
    if (p.visibleSubjects.length === 0) blank = true;
    if (shown(p) && !p.restoring)
      return {
        ms: Math.round(performance.now() - t),
        changeMs,
        blank: blank || p.blankFrames > before.blankFrames,
        reread: p.generation !== before.generation,
      };
    if (performance.now() - t > 120_000) throw new Error('timed out');
    await delay(5);
  }
}

describe('perf: ref and history updates', function () {
  this.timeout(600_000);
  it('measures change to graph', async () => {
    const api = await strata();
    const ui = new ScriptedUi();
    api.setUi(ui);
    const panel = api.show();
    await panel.whenReady();
    await waitFor(
      'first page',
      async () => {
        const p = await panel.probe();
        return p.laidOut >= 300 || (p.done && p.laidOut === p.commits);
      },
      300_000,
      10,
    );
    await panel.simulate({ kind: 'clickRow', index: 3 });
    await waitFor('details', async () => (await panel.probe()).detailsShown !== undefined, 60_000);
    const head = git('rev-parse', 'HEAD');
    // Commits on screen, so their badges are drawn.
    const shown = Object.values((await panel.probe()).rowHashes);
    const results: Record<string, Run[]> = { externalBranch: [], menuBranch: [], externalCommit: [], refresh: [] };
    try {
      for (let i = 0; i < 3; i++) {
        results.externalBranch!.push(
          await time(
            panel,
            () => git('branch', `perf-ext-${i}`, shown[2 + i]!),
            (p) => hasBadge(p, `perf-ext-${i}`),
          ),
        );
        ui.type(`perf-menu-${i}`);
        const at = shown[6 + i]!;
        results.menuBranch!.push(
          await time(
            panel,
            () =>
              vscode.commands.executeCommand('strata.createBranch', {
                webview: 'strata.graph',
                webviewSection: 'commit',
                strataHash: at,
                strataSubject: '',
                strataIsHead: false,
              }),
            (p) => hasBadge(p, `perf-menu-${i}`),
          ),
        );
        git('switch', '--quiet', '--detach', head);
        await delay(1500);
        // The new commit may land far from the rows on screen, which stay: the reloaded history is what shows it.
        const read = (await panel.probe()).generation;
        results.externalCommit!.push(
          await time(
            panel,
            () => git('commit', '--quiet', '--allow-empty', '-m', `perf commit ${i}`),
            (p) => p.generation > read,
          ),
        );
        git('switch', '--quiet', '--detach', head);
        await delay(1500);
        const g = (await panel.probe()).generation;
        results.refresh!.push(
          await time(
            panel,
            () => panel.simulate({ kind: 'click', selector: '.codicon-refresh' }),
            (p) => p.generation > g,
          ),
        );
      }
    } finally {
      git('switch', '--quiet', '--detach', head);
      for (let i = 0; i < 3; i++)
        for (const b of [`perf-ext-${i}`, `perf-menu-${i}`])
          try {
            git('branch', '-D', '--quiet', b);
          } catch {
            // Not made: its run failed.
          }
      api.setUi(undefined);
    }
    console.log(`STRATA_PERF ${JSON.stringify(results)}`);
    panel.dispose();
  });
});
