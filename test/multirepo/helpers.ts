import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { GitApi } from '../../src/host/git-api.ts';
import type { GraphPanel } from '../../src/host/panel.ts';
import { waitFor } from '../integration/helpers.ts';

export const ROOTS = ['alpha', 'beta', join('beta', 'vendor', 'gamma')] as const;

export const rootOf = (name: (typeof ROOTS)[number]): string =>
  join(vscode.workspace.workspaceFolders![0]!.uri.fsPath, name);

export const gitIn = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

export async function gitApi(): Promise<GitApi> {
  const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi }>('vscode.git')!;
  return (ext.isActive ? ext.exports : await ext.activate()).getAPI(1);
}

/** Roots of the repositories VS Code has open, sorted. */
export async function openRoots(): Promise<string[]> {
  return (await gitApi()).repositories.map((r) => r.rootUri.fsPath).sort();
}

/** Waits until VS Code has every fixture repository open. */
export async function allOpen(): Promise<void> {
  const want = ROOTS.map(rootOf).sort();
  await waitFor(
    'the fixture repositories to open',
    async () => JSON.stringify(await openRoots()) === JSON.stringify(want),
    30_000,
  );
}

export async function closeRepo(root: string): Promise<void> {
  await vscode.commands.executeCommand('git.close', root);
  await waitFor(`${root} to close`, async () => !(await openRoots()).includes(root));
}

export async function openRepo(root: string): Promise<void> {
  await vscode.commands.executeCommand('git.openRepository', root);
  await waitFor(`${root} to open`, async () => (await openRoots()).includes(root));
}

/** Waits for the graph to show the whole history of the repository at `root`. */
export async function showing(panel: GraphPanel, root: string): Promise<void> {
  await waitFor(`the graph to show ${root}`, async () => {
    const p = await panel.probe();
    return p.repo === root && p.done && p.commits > 0;
  });
}
