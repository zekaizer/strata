// Message contract between the extension host, the webview and the layout worker.
// Every side imports this file; it must stay free of host- and DOM-only types.
import type { BadgeRule } from '../core/badge-rules.ts';
import type { Commit } from '../core/commit.ts';
import type { CommitDetails, FileChange, FileView } from '../core/details.ts';
import type { FindHit, FindQuery } from '../core/find.ts';

export type { FileView };
import type { LaneState, LayoutCommit, Row, Span } from '../core/layout.ts';
import type { PathFilter, PathOrigin } from '../core/path-filter.ts';
import type { RefSnapshot } from '../core/refs.ts';
import type { ChangesSummary, Leftover, OperationState } from '../core/repo-state.ts';
import type { StashEntry, StashShown } from '../core/stash.ts';
import type { Where } from '../core/where.ts';
import type { CommandId } from './commands.ts';

export type ThemeKind = 'light' | 'dark' | 'high-contrast' | 'high-contrast-light';

export interface ViewOptions {
  firstParent: boolean;
  /** Full ref names whose history is shown; null shows all branches, remote-tracking branches and HEAD. */
  refs: string[] | null;
  /** Whether stashes are drawn as rows; changing it does not reload the history. */
  showStashes: boolean;
  /** Only commits that change these paths (and the tips of the refs shown); null: the whole repository. */
  path: PathFilter | null;
}

export const DEFAULT_OPTIONS: ViewOptions = { firstParent: false, refs: null, showStashes: true, path: null };

/** An open repository, as the repository switcher lists it. */
export interface RepoItem {
  root: string;
  name: string;
  /** Where it is: relative to its workspace folder, else its full path. */
  path: string;
  /** The current branch, or the short commit of a detached HEAD; undefined before the first commit. */
  head: string | undefined;
}

export interface RepoInfo {
  /** Folder name shown in the toolbar. */
  name: string;
  root: string;
}

/** The inline message editor as the host opens it, after checking the commits can be rewritten. */
export interface MessageDraft {
  kind: 'reword' | 'squash';
  /** HEAD when it opened: saving is refused once HEAD has moved. */
  head: string;
  /** The commits whose message it writes, oldest first; it opens under the first. */
  commits: { hash: string; short: string; subject: string; message: string }[];
  /** What it opens with: the message of the (oldest) commit. */
  message: string;
  /** What saving rewrites and moves (rewriteEffects); undefined until the host has read it (editEffects). */
  effects: string | undefined;
}

/**
 * Each `reset` starts a new generation. Messages carry the generation they
 * belong to so late replies for a previous history are dropped.
 */
export type HostToWebview =
  | { type: 'init'; theme: ThemeKind }
  /**
   * `result`: the history after an operation, which marks what it moved; its `focus` is a commit
   * or stash to select and reveal once loaded, instead of the kept selection. `notified`: a
   * notification, which VS Code reads out, says how the operation ended.
   */
  | {
      type: 'reset';
      generation: number;
      repo: RepoInfo;
      refs: RefSnapshot;
      options: ViewOptions;
      stashes: StashEntry[];
      /** The repository's badge rules (BadgeRule), in order. */
      badgeRules: BadgeRule[];
      result?: { focus?: string; notified?: true };
    }
  /** The open repositories in VS Code's order, when they change, after a reset and on request. */
  | { type: 'repositories'; repos: RepoItem[] }
  /** The repository's badge rules changed; the history is not reloaded. */
  | { type: 'badgeRules'; rules: BadgeRule[] }
  /** The stash list changed and nothing else: the rows are interleaved again, the history is not reloaded. */
  | { type: 'stashes'; generation: number; stashes: StashEntry[] }
  /**
   * The uncommitted changes in the work tree, sent after every reset and when they change;
   * undefined when there are none (or the repository has no work tree).
   */
  | { type: 'changes'; generation: number; changes: ChangesSummary | undefined }
  /** Opens the badge filter with `pattern` typed, selected (Hide Similar Badges...). */
  | { type: 'openBadgeFilter'; pattern: string }
  /** Select and open a stash (or commit), loading further history to find it if needed. */
  | { type: 'reveal'; hash: string }
  /**
   * Go to HEAD from the command palette, or after headNotShown: `include` first adds the current
   * branch to the branch filter, or shows every branch with HEAD detached.
   */
  | { type: 'goToHead'; include?: true }
  /** Whether the branch filter's refs reach HEAD, commit `hash`; true when git could not tell. */
  | { type: 'headReached'; generation: number; hash: string; reached: boolean }
  /** The answer to whereIs. */
  | { type: 'where'; generation: number; hash: string; where: Where }
  /**
   * Commits search `id` found, in the graph's order, after those of its earlier messages. `exact`,
   * in the first message only: the commits a hash prefix query names, whether the view has them or not.
   */
  | {
      type: 'findHits';
      generation: number;
      id: number;
      hits: FindHit[];
      exact?: FindHit[];
      done: boolean;
      /** More commits match than the search hands out. */
      capped: boolean;
    }
  /**
   * The answer to locate: `position` is the commit's index in the view's order (stashes not
   * counted), undefined when the view leaves it out; `reachedBy` then names the refs that reach it.
   */
  | {
      type: 'located';
      generation: number;
      id: number;
      hash: string;
      position: number | undefined;
      reachedBy: string[];
    }
  /** The user clicked the action notShown offered for commit `hash`. */
  | { type: 'showNotShown'; hash: string }
  /** Find Commit... from the Command Palette or its key: opens the find widget. */
  | { type: 'find' }
  /** Opens the inline message editor (Edit Message..., Squash Selected Commits...). */
  | { type: 'editMessage'; draft: MessageDraft }
  /** What saving the editor opened at HEAD `head` rewrites and moves, read after it opened. */
  | { type: 'editEffects'; head: string; effects: string }
  /** Save in the message editor ended: `applied` closes it; otherwise it stays open with its text. */
  | { type: 'editEnded'; applied: boolean }
  /** Show Stashes from the Command Palette or the title bar: answered with pickStash, as the stash button does. */
  | { type: 'pickStash' }
  /** A Strata operation started (its progress label, e.g. "Rebasing feature onto main") or ended. */
  | { type: 'busy'; label: string | undefined }
  /**
   * The operation in progress, or else what an earlier one left behind, sent after every reset and
   * when it changes.
   */
  | { type: 'repoState'; operation: OperationState | undefined; leftover: Leftover | undefined }
  /**
   * A page of history; fewer commits than asked for and not done while a path history is still
   * being searched. `unchanged`: commits in it that a path history keeps although they leave its paths alone (ref
   * tips for their badges, merges that join the lines of other kept commits).
   */
  | { type: 'commits'; generation: number; commits: Commit[]; done: boolean; unchanged?: string[] }
  /** How the path history, read to its end, starts. */
  | { type: 'pathOrigin'; generation: number; origin: PathOrigin }
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
  /**
   * What a previous session of this panel saved: the root of the repository it showed last, the
   * view options of each repository it showed by root, and view options saved before they were
   * kept per repository (for the repository shown first).
   */
  | {
      type: 'ready';
      workerOk: boolean;
      last: string | undefined;
      views: Record<string, ViewOptions>;
      options: ViewOptions | undefined;
    }
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
  /** A row's Diff under a one-file path filter: opens the commit's change to that file. */
  | { type: 'openPathDiff'; generation: number; hash: string; beside: boolean }
  /** The path chip's Open File and Copy Relative Path, on a path of the filter. */
  | { type: 'pathAction'; action: 'open' | 'copy'; path: string }
  /** The repository switcher opened: answered with `repositories`, with current branches. */
  | { type: 'listRepositories' }
  /** Shows the repository at `root`, an open one's root. */
  | { type: 'switchRepository'; root: string }
  /** Replaces the repository's badge rules. */
  | { type: 'setBadgeRules'; rules: BadgeRule[] }
  /**
   * Go to HEAD under a branch filter, before loading further history to find HEAD, commit `hash`:
   * answered with headReached.
   */
  | { type: 'reachesHead'; generation: number; hash: string }
  /**
   * The ref card is about to show commit `hash`: answered with where. A newer whereIs stops the
   * query in flight, unanswered; `hash` undefined (the card closed) only stops it.
   */
  | { type: 'whereIs'; generation: number; hash: string | undefined }
  /**
   * Searches the history shown for `query`, answered with findHits. A newer find, findStop or reset
   * stops the search in flight.
   */
  | { type: 'find'; generation: number; id: number; query: FindQuery }
  /** The find widget closed: stops its search and locate in flight. */
  | { type: 'findStop' }
  /**
   * Find went to commit `hash`, which the view leaves out: the host says `message` and offers
   * `action`, answering showNotShown when it is clicked.
   */
  | { type: 'notShown'; hash: string; message: string; action: string | undefined }
  /** Where commit `hash` is in the history shown: answered with located. A newer locate stops this one. */
  | { type: 'locate'; generation: number; id: number; hash: string }
  /** Go to HEAD found HEAD outside the branch filter: answered with goToHead (include) on request. */
  | { type: 'headNotShown'; branch: string | undefined; hash: string }
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

/** The toolbar's badge filter: its button text, and while its popover is open what that shows. */
export interface BadgeFilterProbe {
  button: string;
  pattern: string | undefined;
  /** What the pattern matches, e.g. "Matches 2 branches · 1 hidden". */
  summary: string | undefined;
  /** Whether Hide and Show are enabled. */
  hide: boolean | undefined;
  show: boolean | undefined;
  /** Rule patterns in order, "!" before an exception. */
  rules: string[] | undefined;
  /** Listed refs by short name, " (hidden)" after those whose badge is hidden. */
  refs: string[] | undefined;
  /** The "Show hidden badges (N)" option's text while it is offered. */
  showHidden: string | undefined;
}

/** Webview state reported for integration tests. */
export interface ProbeState {
  generation: number;
  /** Root of the repository shown. */
  repo: string | undefined;
  /** The commits of a multi-selection, newest first; empty without one. */
  selection: string[];
  /** Rendered rows (by index) that a multi-selection cannot take in. */
  outOfReach: number[];
  /** The message editor while open: its commits (oldest first), whether it is on screen, its text, status line and Save label. */
  editor:
    | {
        kind: 'reword' | 'squash';
        commits: string[];
        shown: boolean;
        text: string;
        status: string;
        save: string;
        saving: boolean;
      }
    | undefined;
  /** The multi-selection's panel is shown under its oldest commit. */
  selectionPanel: boolean;
  /**
   * The toolbar's repository name: a label with one repository, else the switcher's button; and
   * while the switcher is open, its rows (name, path, branch), the shown one marked "shown".
   */
  repoSwitcher: { button: boolean; text: string; rows: string[] | undefined; search: boolean };
  commits: number;
  laidOut: number;
  done: boolean;
  /** A reload is still looking for the selection or scroll position it restores. */
  restoring: boolean;
  selected: string | undefined;
  detailsShown: string | undefined;
  /** Subjects of the rendered (visible) rows, top to bottom. */
  visibleSubjects: string[];
  /** The commit or stash commit of each rendered row, by row index. */
  rowHashes: Record<number, string>;
  /** Accessible names of the rendered rows, by commit or stash commit. */
  rowLabels: Record<string, string>;
  /** What rendered rows say about the operation in progress (where it stopped, its target), by commit. */
  operationNotes: Record<string, string>;
  /** Text of the toolbar's ref filter button, e.g. "All". */
  refFilterButton: string;
  /** Text of the toolbar's path chip ("session.ts +1"); empty while it is hidden. */
  pathChip: string;
  /** The note under a path history's last row, while it is shown. */
  pathNote: string | undefined;
  /** Rendered rows of commits a path history keeps although they leave its paths alone, by row index. */
  unchangedRows: number[];
  /**
   * Accessible names of the shown buttons in the toolbar and the inline details, as a screen reader
   * reads them: aria-label, else the text and CSS-generated content (icon glyphs) of what is not
   * aria-hidden, else the title.
   */
  buttonNames: { toolbar: string[]; details: string[] };
  badgeFilter: BadgeFilterProbe;
  /** The ref card while it is shown: its commit, and a line per ref ("v1-rc1 · hidden by *-rc*"). */
  refCard: { hash: string; lines: string[] } | undefined;
  /**
   * The find widget: whether it is open, its input, its count, whether its progress bar shows, how
   * many matches it has and whether its search ended; and of the rendered rows, the marked text by row index, the matching rows'
   * indexes and the texts of the marked badges.
   */
  find: {
    open: boolean;
    input: string;
    count: string;
    progress: boolean;
    matches: number;
    done: boolean;
    marks: Record<number, string[]>;
    hitRows: number[];
    badges: string[];
    /** Marked text in the open details. */
    detailsMarks: string[];
    /** While the match list shows: the text of its headings, rows and notes, in order. */
    list: string[] | undefined;
  };
  /** The repository's badge rules as the host last sent them. */
  badgeRules: BadgeRule[];
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
  /** Computed background and box-shadow of each rendered commit row, by row index. */
  rowPaint: Record<number, { background: string; boxShadow: string }>;
  /** Width of the commit list in CSS px. */
  listWidth: number;
  /** Height of the commit list's visible part in CSS px. */
  listHeight: number;
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
        /** Buttons Tab reaches, and the button with focus. */
        tabStops: string[];
        focus: string | undefined;
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
  /** `y`: px below the row's top to click at (default: its middle); `shiftKey`: Shift-click. */
  | { kind: 'clickRow'; index: number; y?: number; shiftKey?: boolean }
  /** Scrolls the list so row `index` is at the top, as far as the list can scroll. */
  | { kind: 'scrollToRow'; index: number }
  /** Moves the pointer onto row `index`'s graph node, or `dx` px right of it. */
  | { kind: 'hoverNode'; index: number; dx?: number }
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
