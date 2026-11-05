import type { MessageDraft, ViewOptions } from '../shared/protocol.ts';

/** How far a panel remembers the views of the repositories it showed. */
export const REMEMBERED_REPOS = 20;

/** What the graph restores when it shows a repository again. */
export interface RepoView {
  selectedHash?: string | undefined;
  /**
   * The first row in view and how far into it the list is scrolled. Row heights depend on the
   * refs, so a pixel offset alone points at other rows once refs above it change.
   */
  scrollAnchor?: { hash: string; offset: number } | undefined;
  /** Pixel offset; used when the anchor's commit is not found (and by states saved before anchors). */
  scrollTop?: number | undefined;
  /** Whether the selected commit's details were expanded. */
  expanded?: boolean | undefined;
  options?: ViewOptions | undefined;
  /** The inline message editor's draft and text, kept across restarts. */
  draft?: { draft: MessageDraft; text: string } | undefined;
}

/** Persisted with setState: survives hiding and VS Code restarts (the panel is restored by a serializer). */
export interface SavedState {
  /** Root of the repository shown last. */
  last?: string | undefined;
  /** Each repository's view by its root, most recently shown first. */
  repos?: [string, RepoView][] | undefined;
  /** Whether the meta table under the byline is unfolded: a view preference, not tied to a commit. */
  metaOpen?: boolean | undefined;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * The saved state, and the view a state saved before views were kept per repository describes:
 * that view belongs to the repository the panel shows first. The state is the webview's own, but
 * an extension host restart hands it back through the host.
 */
export function parseSaved(raw: unknown): { state: SavedState; unkeyed: RepoView | undefined } {
  if (!isObject(raw)) return { state: {}, unkeyed: undefined };
  const state: SavedState = {};
  if (typeof raw['last'] === 'string') state.last = raw['last'];
  if (Array.isArray(raw['repos']))
    state.repos = raw['repos'].filter(
      (e): e is [string, RepoView] => Array.isArray(e) && typeof e[0] === 'string' && isObject(e[1]),
    );
  if (typeof raw['metaOpen'] === 'boolean') state.metaOpen = raw['metaOpen'];
  if ('repos' in raw) return { state, unkeyed: undefined };
  const { selectedHash, scrollAnchor, scrollTop, expanded, options } = raw as RepoView;
  const unkeyed: RepoView = { selectedHash, scrollAnchor, scrollTop, expanded, options };
  for (const k of Object.keys(unkeyed) as (keyof RepoView)[])
    if (unkeyed[k] === undefined) Reflect.deleteProperty(unkeyed, k);
  return { state, unkeyed: Object.keys(unkeyed).length > 0 ? unkeyed : undefined };
}

/** `state` with `view` as the most recently shown repository's, `root`. */
export function remember(state: SavedState, root: string, view: RepoView): SavedState {
  const others = (state.repos ?? []).filter(([r]) => r !== root);
  return { ...state, last: root, repos: [[root, view] as [string, RepoView], ...others].slice(0, REMEMBERED_REPOS) };
}

export function viewOf(state: SavedState, root: string): RepoView | undefined {
  return state.repos?.find(([r]) => r === root)?.[1];
}

/** The saved view options of each repository, by root. */
export function savedOptions(state: SavedState): Record<string, ViewOptions> {
  const all: Record<string, ViewOptions> = {};
  for (const [root, view] of state.repos ?? []) if (view.options) all[root] = view.options;
  return all;
}

const isString = (v: unknown): v is string => typeof v === 'string';

/** A saved editor draft as setState kept it, or undefined when it is not one. */
export function savedDraft(raw: unknown): { draft: MessageDraft; text: string } | undefined {
  if (!isObject(raw) || !isString(raw['text']) || !isObject(raw['draft'])) return undefined;
  const d = raw['draft'];
  const commits = d['commits'];
  const ok =
    (d['kind'] === 'reword' || d['kind'] === 'squash') &&
    isString(d['head']) &&
    isString(d['message']) &&
    (d['effects'] === undefined || isString(d['effects'])) &&
    Array.isArray(commits) &&
    commits.length > 0 &&
    commits.every(
      (c) =>
        isObject(c) && isString(c['hash']) && isString(c['short']) && isString(c['subject']) && isString(c['message']),
    );
  return ok ? { draft: d as unknown as MessageDraft, text: raw['text'] } : undefined;
}
