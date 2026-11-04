// Message contract between the extension host, the webview and the layout worker.
// Every side imports this file; it must stay free of host- and DOM-only types.
import type { Commit } from '../core/commit.ts';
import type { CommitDetails, FileChange } from '../core/details.ts';
import type { LaneState, LayoutCommit, Row, Span } from '../core/layout.ts';
import type { RefSnapshot } from '../core/refs.ts';

export type ThemeKind = 'light' | 'dark' | 'high-contrast' | 'high-contrast-light';

export interface ViewOptions {
  firstParent: boolean;
  /** Full ref names whose history is shown; null shows all branches, remote-tracking branches and HEAD. */
  refs: string[] | null;
}

export const DEFAULT_OPTIONS: ViewOptions = { firstParent: false, refs: null };

export interface RepoInfo {
  /** Folder name shown in the toolbar. */
  name: string;
  root: string;
}

/**
 * Each `reset` starts a new generation. Messages carry the generation they
 * belong to so late replies for a previous history are dropped.
 */
export type HostToWebview =
  | { type: 'init'; theme: ThemeKind }
  | { type: 'reset'; generation: number; repo: RepoInfo; refs: RefSnapshot; options: ViewOptions }
  | { type: 'commits'; generation: number; commits: Commit[]; done: boolean }
  | { type: 'details'; generation: number; details: CommitDetails }
  | { type: 'noRepository' }
  | { type: 'error'; message: string }
  | { type: 'dumpThemeVars' }
  | { type: 'probe' }
  | { type: 'simulate'; action: SimulatedAction };

export type WebviewToHost =
  /** `options` carries view options saved by a previous session of this panel. */
  | { type: 'ready'; workerOk: boolean; options: ViewOptions | undefined }
  | { type: 'loadMore'; generation: number; count: number }
  | { type: 'select'; generation: number; hash: string }
  | { type: 'openDiff'; generation: number; hash: string; base: string | undefined; file: FileChange; beside: boolean }
  | { type: 'setOptions'; options: ViewOptions }
  | { type: 'refresh' }
  | { type: 'themeVars'; vars: Record<string, string> }
  | { type: 'probe'; state: ProbeState }
  | { type: 'error'; message: string };

/** Webview state reported for integration tests. */
export interface ProbeState {
  generation: number;
  commits: number;
  laidOut: number;
  done: boolean;
  selected: string | undefined;
  detailsShown: string | undefined;
  /** Subjects of the rendered (visible) rows, top to bottom. */
  visibleSubjects: string[];
  /** Path of the file whose diff was opened last in the details pane. */
  openedFile: string | undefined;
  /** Columns currently shown in the commit list. */
  columns: string[];
  options: ViewOptions;
}

/** UI actions integration tests ask the webview to perform through real DOM events. */
export type SimulatedAction =
  | { kind: 'clickRow'; index: number }
  | { kind: 'clickFile'; index: number; altKey?: boolean }
  | { kind: 'key'; key: string; target?: 'list' | 'files' }
  | { kind: 'click'; selector: string }
  | { kind: 'type'; selector: string; text: string };

export type ToWorker = { type: 'ping' } | { type: 'layout'; generation: number; commits: LayoutCommit[] };

/** `state` describes the lines still open below the last row (see SpanIndex.setOpen). */
export type FromWorker =
  { type: 'pong' } | { type: 'rows'; generation: number; rows: Row[]; spans: Span[]; state: LaneState };
