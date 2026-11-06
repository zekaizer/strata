// Find in VS Code, from the user's side, run by `npm run perf:e2e` against the repository in
// STRATA_PERF_REPO. Prints results; not part of the regular suite.
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import * as vscode from 'vscode';
import type { ProbeState } from '../../src/shared/protocol.ts';
import { strata, waitFor, workspaceRoot } from '../integration/helpers.ts';

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: workspaceRoot(), encoding: 'utf8', maxBuffer: 1 << 30 });

describe('perf: find', function () {
  this.timeout(600_000);
  it('measures search, far jumps and stopping', async () => {
    const api = await strata();
    await vscode.commands.executeCommand('strata.show');
    const panel = api.current()!;
    const until = (what: string, test: (s: ProbeState) => boolean, timeout = 300_000) =>
      waitFor(
        what,
        async () => {
          const s = await panel.probe();
          return test(s) && s;
        },
        timeout,
        10,
      );
    await until('first page', (s) => s.laidOut >= 300);
    await vscode.commands.executeCommand('strata.find');
    await until('find open', (s) => s.find.open);
    const results: Record<string, unknown> = {};

    const search = async (label: string, text: string) => {
      const runs: { progressMs: number; firstMs: number; doneMs: number; count: string }[] = [];
      for (let i = 0; i < 3; i++) {
        await panel.simulate({ kind: 'type', selector: '.find-input', text: '' });
        await until('cleared', (s) => s.find.count === '');
        const t = performance.now();
        await panel.simulate({ kind: 'type', selector: '.find-input', text });
        await until('searching', (s) => s.find.count !== '');
        await until('progress shown', (s) => s.find.progress || s.find.done);
        const progressMs = Math.round(performance.now() - t);
        await until('first answer', (s) => s.find.matches > 0 || s.find.done);
        const firstMs = Math.round(performance.now() - t);
        const done = await until('search done', (s) => s.find.done);
        runs.push({ progressMs, firstMs, doneMs: Math.round(performance.now() - t), count: done.find.count });
      }
      results[label] = runs;
      console.log(`STRATA_PERF ${label} ${JSON.stringify(runs)}`);
    };
    // Each time includes the widget's 200 ms typing debounce.
    await search('rare text, whole history scanned', 'xyzzy-no-such-text');
    await search('common text, capped at 10,000', 'bluetooth');
    await search('author', 'author:"Johan Hedberg"');

    const view = git('rev-list', '--topo-order', '--branches', '--remotes', 'HEAD').trim().split('\n');
    const jump = async (label: string, hash: string, text: string) => {
      await vscode.commands.executeCommand('strata.show');
      // A fresh history: the jump loads it from the first page.
      await panel.simulate({ kind: 'click', selector: '.codicon-refresh' });
      await until('reloaded', (s) => s.laidOut >= 300 && !s.restoring);
      await panel.simulate({ kind: 'type', selector: '.find-input', text });
      await until('matched', (s) => s.find.count.startsWith('?') || s.selected === hash);
      const t = performance.now();
      await panel.simulate({ kind: 'focus', selector: '.find-input' });
      await panel.simulate({ kind: 'key', key: 'Enter', target: 'focused' });
      const fb = await until('feedback', (s) => s.find.progress || s.selected === hash);
      const feedbackMs = Math.round(performance.now() - t);
      const s = await until('selected', (p) => p.selected === hash && p.laidOut >= p.commits);
      results[label] = {
        position: view.indexOf(hash),
        feedbackMs,
        feedback: fb.find.count,
        selectedMs: Math.round(performance.now() - t),
        loaded: s.commits,
      };
      console.log(`STRATA_PERF ${label} ${JSON.stringify(results[label])}`);
    };
    const oldest = view.at(-1)!;
    await jump('far jump to the oldest commit (hash)', oldest, oldest.slice(0, 12));
    const middle = view[Math.min(100_000, view.length - 1)]!;
    await jump('far jump to commit #100,000 (hash)', middle, middle.slice(0, 12));
    // A subject near the end of history that only one commit's message holds.
    const unique = view
      .slice(-200)
      .reverse()
      .map((h) => ({ h, subject: git('log', '-1', '--format=%s', h).trim() }))
      .find(
        ({ subject }) =>
          subject.length > 12 &&
          git('rev-list', '--count', '-i', '-F', `--grep=${subject}`, '--branches', '--remotes', 'HEAD').trim() === '1',
      )!;
    await jump('far jump to a commit near the end (message)', unique.h, unique.subject);

    // Escape while loading down to the oldest commit.
    await panel.simulate({ kind: 'click', selector: '.codicon-refresh' });
    await until('reloaded', (s) => s.laidOut >= 300 && !s.restoring);
    await panel.simulate({ kind: 'type', selector: '.find-input', text: oldest.slice(0, 12) });
    await until('matched', (s) => s.find.count.startsWith('?'));
    await panel.simulate({ kind: 'key', key: 'Enter', target: 'focused' });
    await until('loading', (s) => s.status.startsWith('Loading history'));
    const t = performance.now();
    await panel.simulate({ kind: 'key', key: 'Escape', target: 'focused' });
    // The search for the hash may still run (its bar with it) once the jump has stopped.
    const stopped = await until('stopped', (s) => !s.find.count.startsWith('Going to'));
    const stopMs = Math.round(performance.now() - t);
    const settled = await until('no more loading', (s) => !s.status.includes('loading'));
    results['Escape while loading'] = {
      stopMs,
      loadedWhenStopped: stopped.commits,
      loadedAfter: settled.commits,
    };
    console.log(`STRATA_PERF ${JSON.stringify(results)}`);
    panel.dispose();
  });
});
