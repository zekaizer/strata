import { stashPickItems, type StashEntry, type StashShown } from '../core/stash.ts';
import type { Ui } from './ui.ts';

const STATES: readonly StashShown[] = ['drawn', 'notLoaded', 'notInView', 'hidden'];

/** The Show Stashes quick pick; resolves to the chosen stash commit. */
export function pickStash(
  ui: Ui,
  stashes: readonly StashEntry[],
  shown: Readonly<Record<string, unknown>>,
  headBranch: string | undefined,
): Promise<string | undefined> {
  // From the webview: anything but a known state reads as not in the graph.
  const checked = Object.fromEntries(
    stashes.map((s) => [s.hash, STATES.find((state) => state === shown[s.hash]) ?? 'notInView']),
  );
  return ui.pick({
    title: 'Show Stashes',
    placeholder: 'Pick a stash to show it in the graph',
    items: stashPickItems(stashes, checked, headBranch, Date.now() / 1000).map((i) =>
      i.kind === 'separator'
        ? { separator: i.label }
        : { label: `$(git-stash) ${i.label}`, description: i.description, detail: i.detail, value: i.hash },
    ),
  });
}
