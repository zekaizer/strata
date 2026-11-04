import * as vscode from 'vscode';
import { stashPickItems, type StashEntry, type StashShown } from '../core/stash.ts';

const STATES: readonly StashShown[] = ['drawn', 'notLoaded', 'notInView', 'hidden'];

/** The Show Stashes quick pick; resolves to the chosen stash commit. */
export async function pickStash(
  stashes: readonly StashEntry[],
  shown: Readonly<Record<string, unknown>>,
  headBranch: string | undefined,
): Promise<string | undefined> {
  // From the webview: anything but a known state reads as not in the graph.
  const checked = Object.fromEntries(
    stashes.map((s) => [s.hash, STATES.find((state) => state === shown[s.hash]) ?? 'notInView']),
  );
  const items = stashPickItems(stashes, checked, headBranch, Date.now() / 1000).map(
    (i): vscode.QuickPickItem & { hash?: string } =>
      i.kind === 'separator'
        ? { label: i.label, kind: vscode.QuickPickItemKind.Separator }
        : { label: `$(git-stash) ${i.label}`, description: i.description, detail: i.detail, hash: i.hash },
  );
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Show Stashes',
    placeHolder: 'Pick a stash to show it in the graph',
    matchOnDescription: true,
  });
  return picked?.hash;
}
