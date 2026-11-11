import { PATH_HISTORY } from './wording.ts';

/** What the list is asked about when it has no rows. */
export interface EmptyView {
  rows: number;
  noRepository: boolean;
  /** The whole history is read. */
  done: boolean;
  /** The first path of the path filter, when there is one. */
  path: string | undefined;
  /** A ref filter is set. */
  refs: boolean;
}

/**
 * What the list says in place of its rows, by why it has none, and the label of the button that
 * leads out: opening a folder, or removing the filter that left nothing.
 */
export type EmptyState =
  | { kind: 'noRepository'; text: string; action: string }
  | { kind: 'pathFilter'; text: string; action: string }
  | { kind: 'refFilter'; text: string; action: string }
  | { kind: 'noCommits'; text: string; action: undefined };

/** Undefined while there are rows, or while a history that may still bring some is read. */
export function emptyState(view: EmptyView): EmptyState | undefined {
  if (view.rows > 0) return undefined;
  if (view.noRepository)
    return {
      kind: 'noRepository',
      text: 'No git repository in this workspace. Open a folder that contains one.',
      action: 'Open Folder...',
    };
  if (!view.done) return undefined;
  if (view.path !== undefined)
    return { kind: 'pathFilter', text: `${PATH_HISTORY.found(view.path, 0)}.`, action: 'Show All Files' };
  if (view.refs) return { kind: 'refFilter', text: 'No commits on the selected refs.', action: 'Show All' };
  return { kind: 'noCommits', text: 'No commits yet.', action: undefined };
}
