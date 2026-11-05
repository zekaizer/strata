// Message contract between the extension host, the webview and the layout worker.
// Every side imports this file; it must stay free of host- and DOM-only types.
import type { Commit } from '../core/commit.ts';
import type { CommitDetails, FileChange, FileView } from '../core/details.ts';

export type { FileView };
import type { LaneState, LayoutCommit, Row, Span } from '../core/layout.ts';
import type { RefSnapshot } from '../core/refs.ts';
import type { Leftover, OperationState } from '../core/repo-state.ts';
import type { StashEntry, StashShown } from '../core/stash.ts';
import type { CommandId } from './commands.ts';

export type ThemeKind = 'light' | 'dark' | 'high-contrast' | 'high-contrast-light';

export interface ViewOptions {
  firstParent: boolean;
  /** Full ref names whose history is shown; null shows all branches, remote-tracking branches and HEAD. */
  refs: string[] | null;
  /** Whether stashes are drawn as rows; changing it does not reload the history. */
  showStashes: boolean;
}

export const DEFAULT_OPTIONS: ViewOptions = { firstParent: false, refs: null, showStashes: true };

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
  /**
   * `result`: the history after an operation, which marks what it moved; its `focus` is a commit
   * or stash to select and reveal once loaded, instead of the kept selection.
   */
  | {
      type: 'reset';
      generation: number;
      repo: RepoInfo;
      refs: RefSnapshot;
      options: ViewOptions;
      stashes: StashEntry[];
      result?: { focus?: string };
    }
  /** The stash list changed and nothing else: the rows are interleaved again, the history is not reloaded. */
  | { type: 'stashes'; generation: number; stashes: StashEntry[] }
  /** Select and open a stash (or commit), loading further history to find it if needed. */
  | { type: 'reveal'; hash: string }
  /** Show Stashes from the Command Palette or the title bar: answered with pickStash, as the stash button does. */
  | { type: 'pickStash' }
  /** A Strata operation started (its progress label, e.g. "Rebasing feature onto main") or ended. */
  | { type: 'busy'; label: string | undefined }
  /**
   * The operation in progress, or else what an earlier one left behind, sent after every reset and
   * when it changes.
   */
  | { type: 'repoState'; operation: OperationState | undefined; leftover: Leftover | undefined }
  | { type: 'commits'; generation: number; commits: Commit[]; done: boolean }
  | { type: 'details'; generation: number; details: CommitDetails }
  | { type: 'noRepository' }
  /** The panel was hidden behind another editor (VS Code knows; the webview's own events may not tell). */
  | { type: 'hidden' }
  /** Path of the commit's file whose tab (opened from the graph) is on screen, if any. */
  | { type: 'activeFile'; path: string | undefined }
  | { type: 'error'; message: string }
  /** The result of an action, for screen readers (the host also shows it in the status bar). */
  | { type: 'notice'; message: string }
  | { type: 'dumpThemeVars' }
  | { type: 'probe' }
  | { type: 'simulate'; action: SimulatedAction };

export type WebviewToHost =
  /** `options` carries view options saved by a previous session of this panel. */
  | { type: 'ready'; workerOk: boolean; options: ViewOptions | undefined }
  | { type: 'loadMore'; generation: number; count: number }
  | { type: 'select'; generation: number; hash: string }
  | {
      type: 'openFile';
      generation: number;
      hash: string;
      base: string | undefined;
      file: FileChange;
      view: FileView;
      beside: boolean;
    }
  | { type: 'setOptions'; options: ViewOptions }
  /** The stash count button: whether each stash's row is in the graph, which only the webview knows. */
  | { type: 'pickStash'; shown: Record<string, StashShown> }
  /** Runs a command of the table from a keyboard shortcut or a button, with the element's menu context. */
  | { type: 'menuCommand'; command: CommandId; context: Record<string, unknown> }
  | { type: 'refresh' }
  /** The view state the webview also keeps with setState, mirrored for re-creating the panel. */
  | { type: 'state'; state: unknown }
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
  /** The commit or stash commit of each rendered row, by row index. */
  rowHashes: Record<number, string>;
  /** Label of the toolbar's stash count button; empty while it is hidden. */
  stashButton: string;
  /** Rendered stash rows by row index: badge, subject cell and aria-label text, and menu context. */
  stashRows: Record<
    number,
    { badge: string; text: string; label: string; autostash: boolean; context: Record<string, unknown> }
  >;
  /** Path of the file whose diff was opened last in the details pane. */
  openedFile: string | undefined;
  /**
   * `data-vscode-context` of the changed files, of the selected row, and of the badges and remote
   * names of each rendered row by row index, in document order (context menu arguments).
   */
  menuContexts: {
    files: Record<string, unknown>[];
    selectedRow: Record<string, unknown> | undefined;
    badges: Record<number, Record<string, unknown>[]>;
  };
  /** The element marked as the open context menu's target: its context, text and outline style. */
  menuTarget: { context: Record<string, unknown>; text: string; outline: string } | undefined;
  /** VS Code's body.vscode-context-menu-visible. */
  menuShown: boolean;
  /** Per changed file in the details, which views can be opened. */
  fileViews: { path: string; views: FileView[] }[];
  /** Columns currently shown in the commit list. */
  columns: string[];
  /** Visible entries of the changed-files tree: folders end with "/", two spaces per level. */
  fileTree: string[];
  /** Full subject shown at the top of the expanded details. */
  detailsSubject: string | undefined;
  /** Whether hover highlights are off because the pointer left the webview (or it was hidden). */
  hoverSuppressed: boolean;
  /** Width of the commit list in CSS px. */
  listWidth: number;
  /** Height in px of the details expanded under the selected row; 0 when collapsed. */
  expandedHeight: number;
  /** Top offset in px of each rendered row within the list, by row index. */
  rowTops: Record<number, number>;
  /** Scroll offset of the commit list in px. */
  scrollTop: number;
  /** Rendered height in px of each rendered row, by row index. */
  rowHeights: Record<number, number>;
  /**
   * Ref badges of each rendered row that has any, by row index: the badge texts and where the
   * band holding them ends relative to where the subject starts (both in px from the row top).
   */
  refBands: Record<
    number,
    {
      badges: string[];
      /** Whether each badge is the current branch's (or detached HEAD's). */
      head: boolean[];
      /** Computed text color of each badge, and of the row's subject and author for comparison. */
      colors: string[];
      subjectColor: string;
      authorColor: string;
      /** Lowest badge edge and the subject text's top, in px from the row top. */
      badgeBottom: number;
      subjectTop: number;
      subjectLeft: number;
      bandLeft: number;
      /** Full names of every ref behind the badges, merged badges included. */
      refNames: string[];
    }
  >;
  /** The inline details as laid out, or undefined when collapsed. */
  details?:
    | {
        /** Class names of the blocks of the message column, then of the files column, in DOM order. */
        blocks: string[];
        /** Whether the message and the files sit side by side (wide lists). */
        sideBySide: boolean;
        byline: string;
        metaOpen: boolean;
        /** Row labels of the unfolded meta table. */
        metaRows: string[];
        filesSummary: string;
        bodyClamp: { clamped: boolean; hiddenLines: number };
        /** The more-below marker, and whether the details actually continue below their visible part. */
        moreBelow: boolean;
        overflowing: boolean;
        filesMulticol: boolean;
        /** The message and the files wrapped onto separate lines (not enough room side by side). */
        stacked: boolean;
        /** Width given to one tree column: the tree's widest row, within limits. */
        treeWidth: number;
        /** Tree columns. */
        cols: number;
        /** Rightmost edge of any file's Old | diff | New control, from the tree's left edge. */
        actionsRight: number;
        listWidth: number;
        /** Left edge of the files column, in px from the message column's left edge. */
        filesLeft: number;
        /** The graph column's width when this was probed (the details start after it). */
        graphWidth: number;
        /** Widths in px of the details layout, of the message column, and of 80 columns of the body font. */
        layoutWidth: number;
        messageWidth: number;
        bodyColumns80: number;
        /** Whether a line of the shown (unfolded) body wraps. */
        bodyWraps: boolean;
      }
    | undefined;
  /** Width of the author column and of the widest author name rendered in it, in px. */
  authorColumn: { column: number; widestName: number };
  /** Whether the selected row is drawn as selected (only while its details are open). */
  selectionShown: boolean;
  /** Whether any file row shows Old | diff | New with neither the pointer nor keyboard focus on it. */
  idleFileActions: boolean;
  /** Computed outline style of the selected row ('none' when it has no visible outline). */
  selectionOutline: string;
  /** Text last announced to screen readers. */
  announced: string;
  /** Text last said at once (role=alert). */
  alerted: string;
  /** Rendered elements marked as moved by the last operation: a badge's refs or "stash:<hash>", and how they show it. */
  landed: { refs: string; animation: string; outline: string }[];
  /**
   * The banner above the list: its state, region name, sentence, look, buttons and the commits it
   * links; `busy` is the running operation it shows instead of usable buttons.
   */
  banner:
    | {
        state: string;
        label: string;
        text: string;
        warning: boolean;
        buttons: string[];
        links: string[];
        busy: string | undefined;
      }
    | undefined;
  /** The toolbar's status text. */
  status: string;
  /** The list's aria-busy. */
  listBusy: boolean;
  /** Class name of the focused element. */
  focused: string;
  options: ViewOptions;
  /** The operation in progress, and what an earlier one left behind, as the host last reported them. */
  operation: OperationState | undefined;
  leftover: Leftover | undefined;
}

/** UI actions integration tests ask the webview to perform through real DOM events. */
export type SimulatedAction =
  /** `y`: px below the row's top to click at (default: its middle). */
  | { kind: 'clickRow'; index: number; y?: number }
  /** Scrolls the list so row `index` is at the top, as far as the list can scroll. */
  | { kind: 'scrollToRow'; index: number }
  | { kind: 'clickFile'; index: number; altKey?: boolean; view?: FileView }
  | {
      kind: 'key';
      key: string;
      target?: 'list' | 'files' | 'focused';
      shiftKey?: boolean;
      ctrlKey?: boolean;
      altKey?: boolean;
      metaKey?: boolean;
    }
  | { kind: 'click'; selector: string }
  | { kind: 'contextMenu'; selector: string }
  /** Selects the text of the element, as a drag over it would; none when nothing matches. */
  | { kind: 'selectText'; selector: string }
  /** What Chromium sends for Shift+F10 or the Menu key: a contextmenu on the focused list (button -1). */
  | { kind: 'keyboardContextMenu' }
  | { kind: 'focus'; selector: string }
  | { kind: 'type'; selector: string; text: string };

export type ToWorker = { type: 'ping' } | { type: 'layout'; generation: number; commits: LayoutCommit[] };

/** `state` describes the lines still open below the last row (see SpanIndex.setOpen). */
export type FromWorker =
  { type: 'pong' } | { type: 'rows'; generation: number; rows: Row[]; spans: Span[]; state: LaneState };
