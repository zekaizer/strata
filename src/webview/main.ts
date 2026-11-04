import type { Commit } from '../core/commit.ts';
import { filesSummary, fileViews, type CommitDetails, type FileChange, type FileView } from '../core/details.ts';
import { buildFileTree, type FileTreeNode } from '../core/file-tree.ts';
import { SpanIndex, type Row } from '../core/layout.ts';
import { reflowBody } from '../core/message.ts';
import { badgeOrder, type Ref, type RefSnapshot } from '../core/refs.ts';
import type { Leftover, OperationState } from '../core/repo-state.ts';
import {
  anchoredAt,
  describeStash,
  interleave,
  rowHash,
  stashLabel,
  type ListRow,
  type StashEntry,
  type StashShown,
} from '../core/stash.ts';
import { MENU_SECTIONS } from '../shared/commands.ts';
import type { CommitContext, StashContext } from '../shared/menu-context.ts';
import { DEFAULT_OPTIONS } from '../shared/protocol.ts';
import type {
  FromWorker,
  HostToWebview,
  ProbeState,
  RepoInfo,
  SimulatedAction,
  ViewOptions,
} from '../shared/protocol.ts';
import { rowBadges, type Badge } from './badges.ts';
import { el, formatDate, formatShortDate, shortHash } from './format.ts';
import { drawGraph, graphWidth, ROW_HEIGHT } from './graph.ts';
import { lanesUsed } from './lanes.ts';
import { RefFilter } from './ref-filter.ts';
import { chooseColumns, type ColumnChoice } from './columns.ts';
import { expansionCap, pageFrom, RowGeometry } from './row-geometry.ts';
import { resolveGraphTheme, type GraphTheme } from './theme.ts';
import { savedState, vscode } from './vscode.ts';
import { ping, startWorker } from './worker-client.ts';

const FIRST_PAGE = 300;
const NEXT_PAGE = 1000;
/** Load more once the viewport is this many rows from the end of the loaded history. */
const LOAD_AHEAD = 200;
const OVERSCAN = 8;
const MAX_GRAPH_SHARE = 0.4;
/** Narrow lists keep most of their width for the text. */
const NARROW_LIST = 600;
const NARROW_GRAPH_SHARE = 0.25;
/** Height of the band above the commit line of rows with refs; matches --ref-band in main.css. */
const REF_BAND = 14;
/** The inline details never take more than this share of the list height. */
const MAX_EXPANSION_SHARE = 0.45;

/** Persisted with setState: survives hiding and VS Code restarts (the panel is restored by a serializer). */
interface SavedState {
  selectedHash?: string | undefined;
  /**
   * The first row in view and how far into it the list is scrolled. Row heights depend on the
   * refs, so a pixel offset alone points at other rows once refs above it change.
   */
  scrollAnchor?: { hash: string; offset: number } | undefined;
  /** Pixel offset; used when the anchor's commit is not found (and by states saved before anchors). */
  scrollTop?: number | undefined;
  /** Set when a scroll position was restored together with the selection; do not scroll to the selection. */
  keepScroll?: boolean | undefined;
  /** The selection is the host's focus hint: reveal it even when a scroll position is restored with it. */
  reveal?: boolean | undefined;
  /** Whether the selected commit's details were expanded. */
  expanded?: boolean | undefined;
  /** Loaded commits past which a restore stops looking; default RESTORE_SEARCH_LIMIT. Not saved. */
  searchLimit?: number | undefined;
  /** Whether the meta table under the byline is unfolded: a view preference, not tied to a commit. */
  metaOpen?: boolean | undefined;
  options?: ViewOptions | undefined;
}

/** Details that take longer than this are reported as not coming (the extension host went away). */
const DETAILS_TIMEOUT_MS = 15_000;
/** Above the files, a long body shows this many lines until "Show more"; beside them it is never folded. */
const BODY_LINES = 6;
/** A tree column is as wide as the tree's widest row, but at least this (and at most the files' room). */
const TREE_MIN = 200;
/** Gap between tree columns; matches main.css. */
const TREE_COL_GAP = 24;
const TREE_MAX_COLS = 4;
/** The subject keeps at least this much room; author and date give way first. */
const SUBJECT_MIN = 300;
/** Longer author names are cut with an ellipsis. */
const AUTHOR_MAX = 180;

/** Trees flow into columns only between these row counts: a few rows read better in one column. */
const MULTICOL_MIN_ROWS = 8;
const MULTICOL_MAX_ROWS = 300;

/** Restoring a selection loads at most this many commits looking for it. */
const RESTORE_SEARCH_LIMIT = 5000;

/**
 * Old and New are words: no icon says "this file before / after the commit" without being read as
 * history or navigation. The diff keeps Source Control's "Open Changes" icon.
 */
const FILE_VIEW_LABEL: Record<FileView, string | undefined> = { before: 'Old', diff: undefined, after: 'New' };
/** Buttons follow time: before, the change, after. */
const FILE_VIEW_ORDER: readonly FileView[] = ['before', 'diff', 'after'];
const FILE_VIEW_TITLE: Record<FileView, string> = {
  diff: 'Open changes',
  before: 'Open old version (before this commit)',
  after: 'Open new version (as of this commit)',
};
const FILE_VIEW_KEY: Record<FileView, string> = { diff: 'D', before: 'O', after: 'N' };

const BADGE_ICON: Record<Exclude<Badge['look'], 'more'>, string> = {
  head: 'target',
  branch: 'git-branch',
  remote: 'cloud',
  tag: 'tag',
};

class App {
  private worker: Worker | undefined;
  private theme: GraphTheme = resolveGraphTheme();

  private generation = -1;
  private repo: RepoInfo | undefined;
  private refs: RefSnapshot = { head: undefined, headBranch: undefined, refs: [], remotes: [] };
  private refsByHash = new Map<string, Ref[]>();
  // Declared before `options`, which is initialized from it.
  private restore: SavedState | undefined = savedState() as SavedState | undefined;
  // States saved before an option existed lack it.
  private options: ViewOptions = { ...DEFAULT_OPTIONS, ...this.restore?.options };
  private readonly refFilter: RefFilter;
  private readonly firstParentButton = el('button', 'tool-button first-parent-button');
  /** "▣ 4 stashes · 1 not shown"; opens Show Stashes. */
  private readonly stashButton = el('button', 'tool-button stash-button');
  /** The loaded history, in layout order: `rows[i]` is the layout of `commits[i]`. */
  private commits: Commit[] = [];
  private rows: Row[] = [];
  /** What the list shows, top to bottom: the commits with the stashes drawn above them. Row indexes count these. */
  private list: ListRow[] = [];
  private stashes: StashEntry[] = [];
  /** Stashes by the commit their rows are drawn above. */
  private anchors: ReadonlyMap<string, readonly StashEntry[]> = new Map();
  private readonly spans = new SpanIndex();
  /**
   * Columns the graph column is sized for: the widest rows seen on screen so far. It only grows
   * within one history, so the text does not shift back and forth while scrolling.
   */
  private shownLanes = 1;
  /** Row tops without the inline details; rows with refs are taller. */
  private readonly geometry = new RowGeometry(ROW_HEIGHT, REF_BAND);
  private noRepository = false;
  private readonly empty = el('div', 'empty');
  private done = false;
  private loading = false;
  private selected = -1;
  private details: CommitDetails | undefined;
  /** Commit whose details were last requested; replies for any other commit are stale. */
  private pendingDetails: string | undefined;
  private openedFile: string | undefined;
  /** Folders folded in the changed-files tree of the expanded commit. */
  private foldedFolders = new Set<string>();
  /** Read directly: `restore` is cleared once applied, but this preference outlives it. */
  private metaOpen = (savedState() as SavedState | undefined)?.metaOpen ?? false;
  /** Whether the selected commit's body is shown in full. */
  private bodyExpanded = false;
  private copiedTimer: ReturnType<typeof setTimeout> | undefined;
  /** Announces results of actions (a copy) to screen readers. */
  private readonly announcer = el('div', 'sr-only');
  private announced = '';
  /** Widest author name and dates of the loaded commits, in px (the row's own font). */
  private textWidths = { author: 0, dateFull: 0, dateShort: 0 };
  private operation: OperationState | undefined;
  private leftover: Leftover | undefined;
  /** The Strata operation running, by its progress label. */
  private busyLabel: string | undefined;
  /** Selections the user made; an operation's focus is not applied once the user moved during it. */
  private selections = 0;
  private selectionsAtBusy: number | undefined;
  /**
   * The row element a context menu is open on, by row index and place among the row's menu
   * targets: rows are re-rendered while the menu is open.
   */
  private menuTarget: { row: number; target: number } | undefined;
  private measureContext: CanvasRenderingContext2D | null | undefined;
  private columns: ColumnChoice | undefined;
  /** Natural width of the expanded commit's file tree (widest row, Old | diff | New included). */
  private treeNatural = 0;
  /** Graph and list widths the details were last laid out for. */
  private laidOutWidths = '';
  private mirrorTimer: ReturnType<typeof setTimeout> | undefined;
  private metaCopiedTimer: ReturnType<typeof setTimeout> | undefined;
  /** Shows a message when requested details never arrive (the host went away). */
  private loadingTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly toolbar = el('header', 'toolbar');
  private readonly repoLabel = el('span', 'repo');
  private readonly status = el('span', 'status');
  private readonly viewport = el('div', 'viewport');
  private readonly scroller = el('div', 'scroller');
  private readonly sizer = el('div', 'sizer');
  private readonly canvas = el('canvas', 'graph');
  /** Rendered rows; kept apart from the expansion so re-rendering rows does not touch it. */
  private readonly rowsLayer = el('div', 'rows');
  /** Commit details shown inline under the selected row. */
  private readonly expansion = el('section', 'expansion');
  /** Whether the selected commit's details are open under it. */
  private expanded = false;
  /** Measured height of the expansion in px; 0 when collapsed. */
  private gap = 0;
  /** Keep the expansion in view once it has its final height. */
  private revealExpansion = false;
  private renderQueued = false;
  private readonly root: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    const refresh = el('button', 'icon-button codicon codicon-refresh');
    refresh.title = 'Refresh';
    refresh.addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });
    this.refFilter = new RefFilter(
      this.toolbar,
      (refs) => {
        this.setOptions({ ...this.options, refs });
      },
      (show) => {
        this.setShowStashes(show);
      },
    );
    this.stashButton.append(
      el('span', 'codicon codicon-git-stash'),
      el('span', 'tool-label stash-count'),
      el('span', 'stash-count-narrow'),
    );
    this.stashButton.hidden = true;
    this.stashButton.addEventListener('click', () => {
      vscode.postMessage({ type: 'pickStash', shown: this.stashShown() });
    });
    this.firstParentButton.append(el('span', 'codicon codicon-git-commit'), el('span', 'tool-label', 'First parent'));
    this.firstParentButton.title = 'Follow only the first parent of merges';
    this.firstParentButton.addEventListener('click', () => {
      this.setOptions({ ...this.options, firstParent: !this.options.firstParent });
    });
    this.updateOptionControls();
    this.toolbar.append(
      this.repoLabel,
      this.status,
      el('span', 'spacer'),
      this.stashButton,
      this.refFilter.button,
      this.firstParentButton,
      refresh,
    );

    this.scroller.tabIndex = 0;
    this.scroller.setAttribute('role', 'listbox');
    this.scroller.setAttribute('aria-label', 'Commits');
    this.expansion.hidden = true;
    this.expansion.setAttribute('role', 'region');
    this.expansion.setAttribute('aria-label', 'Commit details');
    this.empty.hidden = true;
    this.sizer.append(this.rowsLayer, this.expansion, this.empty);
    this.scroller.append(this.sizer);
    this.viewport.append(this.scroller, this.canvas);
    this.announcer.setAttribute('role', 'status');
    this.announcer.setAttribute('aria-live', 'polite');
    root.replaceChildren(this.toolbar, this.viewport, this.announcer);
    // Escape from anywhere in the details goes back to the list; the selection stays.
    this.expansion.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      this.scroller.focus();
    });
    // A mouse click on a one-shot control hands the keyboard back to the list, so no focus ring
    // appears on it at the next key and the list keys keep working. Keyboard activation (detail 0)
    // leaves focus where it is.
    const giveBack = (e: MouseEvent, controls: string) => {
      if (e.detail > 0 && (e.target as Element).closest(controls)) this.scroller.focus({ preventScroll: true });
    };
    this.expansion.addEventListener('click', (e) => {
      giveBack(e, '.byline-hash, .byline-toggle, .meta-copy, .details-more');
    });
    this.toolbar.addEventListener('click', (e) => {
      giveBack(e, '.first-parent-button, .codicon-refresh, .stash-button');
    });
    new ResizeObserver(() => {
      this.onExpansionResize();
      this.updateExpansionOverflow();
    }).observe(this.expansion);
    this.expansion.addEventListener('scroll', () => {
      this.updateExpansionOverflow();
    });

    this.scroller.addEventListener('scroll', () => {
      this.queueRender();
      this.saveState();
    });
    // Rows are rebuilt on every render, so the clicked element may be gone by mouseup; use the position.
    this.scroller.addEventListener('click', (e) => {
      // By the dispatch path: the target may already be detached (a fold or a parent link
      // rebuilds the details), and its position would then hit the row under the pointer.
      if (e.composedPath().includes(this.expansion)) return;
      const top = this.scroller.getBoundingClientRect().top;
      const index = this.rowAt(e.clientY - top + this.scroller.scrollTop);
      if (index < 0 || index >= this.list.length) return;
      // Clicking the expanded row folds it; any other row opens its details.
      if (index === this.selected && this.expanded) this.userCollapse();
      else this.userSelect(index, { expand: true });
    });
    // List keys only when the list itself has focus: keys typed in the details (file tree, links)
    // bubble up through the scroller and must not move the commit selection.
    this.scroller.addEventListener('keydown', (e) => {
      if (e.target === this.scroller) this.onKey(e);
    });
    this.trackMenuTarget();
    new ResizeObserver(() => {
      this.queueRender();
      this.layoutDetails();
    }).observe(this.viewport);
    this.watchPixelRatio();
    this.trackPointer();
    this.trackInputModality();
    // VS Code rewrites the theme and font variables on <html> when the theme or a font setting changes.
    new MutationObserver(() => {
      this.theme = resolveGraphTheme();
      this.queueRender();
      this.layoutDetails();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  }

  async boot(): Promise<void> {
    let workerOk = false;
    try {
      this.worker = await startWorker(document.body.dataset['workerSrc'] ?? '');
      await ping(this.worker);
      this.worker.addEventListener('message', (e: MessageEvent<FromWorker>) => {
        this.onWorker(e.data);
      });
      workerOk = true;
    } catch (err) {
      vscode.postMessage({ type: 'error', message: `layout worker: ${String(err)}` });
    }
    window.addEventListener('message', (e: MessageEvent<HostToWebview>) => {
      this.onHost(e.data);
    });
    vscode.postMessage({ type: 'ready', workerOk, options: this.options });
  }

  private onHost(m: HostToWebview): void {
    switch (m.type) {
      case 'init':
        document.body.dataset['theme'] = m.theme;
        this.theme = resolveGraphTheme();
        this.queueRender();
        break;
      case 'reset':
        this.reset(m.generation, m.repo, m.refs, m.options, m.stashes, m.focus);
        break;
      case 'stashes':
        if (m.generation !== this.generation) return;
        this.setStashes(m.stashes);
        this.relist();
        break;
      case 'busy':
        this.busyLabel = m.label;
        if (m.label !== undefined) this.selectionsAtBusy = this.selections;
        if (m.label === undefined) this.scroller.removeAttribute('aria-busy');
        else this.scroller.setAttribute('aria-busy', 'true');
        // An error shown meanwhile stays until the next action.
        if (m.label !== undefined || !this.status.classList.contains('error')) this.updateStatus();
        break;
      case 'repoState':
        this.operation = m.operation;
        this.leftover = m.leftover;
        // Stash rows carry whether restoring them conflicted.
        this.queueRender();
        break;
      case 'commits':
        if (m.generation !== this.generation) return;
        this.loading = false;
        this.done = m.done;
        this.appendRows(interleave(m.commits, this.commits.length, this.anchors));
        this.commits.push(...m.commits);
        this.measureTexts(m.commits);
        this.worker?.postMessage({
          type: 'layout',
          generation: m.generation,
          commits: m.commits.map((c) => ({ hash: c.hash, parents: c.parents })),
        });
        this.updateStatus();
        this.updateStashButton();
        this.applyRestore();
        this.queueRender();
        break;
      case 'details':
        if (m.generation !== this.generation || m.details.hash !== this.pendingDetails || !this.expanded) return;
        this.pendingDetails = undefined;
        this.details = m.details;
        this.renderDetails();
        break;
      case 'reveal':
        this.reveal(m.hash);
        break;
      case 'activeFile':
        // The host says which file's tab is on screen; the marker follows it and goes when it closes.
        this.markOpenedFile(m.path);
        break;
      case 'hidden':
        document.body.classList.add('hover-off');
        this.refFilter.close();
        break;
      case 'noRepository':
        this.generation = -1;
        this.noRepository = true;
        this.repoLabel.textContent = 'No git repository';
        this.repoLabel.title = '';
        this.status.classList.remove('error');
        this.status.textContent = 'Open a folder that contains a git repository.';
        this.refFilter.close();
        this.refs = { head: undefined, headBranch: undefined, refs: [], remotes: [] };
        this.refFilter.update(this.refs, null);
        this.setStashes([]);
        this.commits = [];
        this.list = [];
        this.geometry.clear();
        this.rows = [];
        this.spans.clear();
        this.queueRender();
        break;
      case 'error':
        this.loading = false;
        this.status.textContent = m.message;
        this.status.classList.add('error');
        break;
      case 'notice':
        this.announce(m.message);
        break;
      case 'dumpThemeVars':
        vscode.postMessage({ type: 'themeVars', vars: readThemeVars() });
        break;
      case 'probe':
        vscode.postMessage({ type: 'probe', state: this.probe() });
        break;
      case 'simulate':
        this.simulate(m.action);
        break;
    }
  }

  private onWorker(m: FromWorker): void {
    if (m.type !== 'rows' || m.generation !== this.generation) return;
    this.rows.push(...m.rows);
    this.spans.add(m.spans);
    this.spans.setOpen(m.state);
    this.queueRender();
  }

  private reset(
    generation: number,
    repo: RepoInfo,
    refs: RefSnapshot,
    options: ViewOptions,
    stashes: StashEntry[],
    focus?: string,
  ): void {
    // A reload of the same repository (refs changed, refresh, filters) keeps the selection, and the
    // scroll position too when the history itself is the same view.
    if (this.restore === undefined && this.repo?.root === repo.root) {
      const sameView = JSON.stringify(options) === JSON.stringify(this.options);
      this.restore = {
        selectedHash: this.selectedHash(),
        scrollAnchor: sameView ? this.scrollAnchor() : undefined,
        scrollTop: sameView ? this.scroller.scrollTop : undefined,
        expanded: this.expanded,
        // What was in the history before a reload is within what was loaded; past one more page, it is gone.
        searchLimit: Math.max(this.commits.length, FIRST_PAGE) + NEXT_PAGE,
      };
    }
    const moved = this.selectionsAtBusy !== undefined && this.selectionsAtBusy !== this.selections;
    if (focus !== undefined && !moved) this.restore = { ...this.restore, selectedHash: focus, reveal: true };
    if (focus !== undefined) this.selectionsAtBusy = undefined;
    this.generation = generation;
    this.repo = repo;
    this.refs = refs;
    this.options = options;
    this.refsByHash = new Map();
    for (const r of refs.refs) {
      const list = this.refsByHash.get(r.hash) ?? [];
      list.push(r);
      this.refsByHash.set(r.hash, list);
    }
    // Refs picked in the filter follow the current branch, so they survive the "+N" collapse.
    for (const [hash, list] of this.refsByHash)
      this.refsByHash.set(hash, badgeOrder(list, refs.headBranch, options.refs));
    this.setStashes(stashes);
    this.commits = [];
    this.list = [];
    this.geometry.clear();
    this.rows = [];
    this.spans.clear();
    this.shownLanes = 1;
    this.textWidths = { author: 0, dateFull: 0, dateShort: 0 };
    this.noRepository = false;
    this.done = false;
    this.selected = -1;
    this.updateOptionControls();
    this.repoLabel.textContent = repo.name;
    this.repoLabel.title = repo.root;
    this.status.classList.remove('error');
    // Replies to requests of the previous generation are dropped, so nothing is in flight any more.
    this.loading = false;
    this.loadMore(FIRST_PAGE);
    this.collapse();
    this.queueRender();
  }

  /** Re-applies the saved scroll position and selection once the history containing them has loaded. */
  private applyRestore(): void {
    const r = this.restore;
    if (!r) return;
    if (r.scrollTop !== undefined || r.scrollAnchor !== undefined) r.keepScroll = true;
    const searchable = !this.done && this.commits.length < (r.searchLimit ?? RESTORE_SEARCH_LIMIT);
    if (r.scrollAnchor !== undefined) {
      const anchor = r.scrollAnchor;
      const index = this.indexOf(anchor.hash);
      if (index >= 0) {
        this.syncSizer();
        this.scroller.scrollTop = this.rowTop(index) + anchor.offset;
        r.scrollAnchor = undefined;
        r.scrollTop = undefined;
      } else if (searchable) {
        this.loadMore(NEXT_PAGE);
      } else {
        // Gone from the history: fall back to the pixel offset.
        r.scrollAnchor = undefined;
      }
    }
    if (r.scrollAnchor === undefined && r.scrollTop !== undefined) {
      // The sizer normally grows in the next render; it must be tall enough now or the browser clamps scrollTop.
      this.syncSizer();
      this.scroller.scrollTop = r.scrollTop;
      if (Math.abs(this.scroller.scrollTop - r.scrollTop) < 1 || !searchable) r.scrollTop = undefined;
      else this.loadMore(NEXT_PAGE);
    }
    if (r.selectedHash !== undefined) {
      const index = this.indexOf(r.selectedHash);
      if (index >= 0) {
        // Reveal it only when no scroll position is being restored with it. Older saved states have no
        // `expanded`; a selection then meant visible details.
        this.select(index, {
          reveal: r.reveal === true || (r.scrollTop === undefined && !r.keepScroll),
          expand: r.expanded ?? true,
        });
        r.selectedHash = undefined;
      } else if (searchable) {
        this.loadMore(NEXT_PAGE);
      } else {
        // Not in this view (filters, first parent): say so instead of leaving "Looking for…".
        const missing = r.selectedHash;
        r.selectedHash = undefined;
        this.updateStatus();
        const stash = this.stashes.find((s) => s.hash === missing);
        this.announce(`${stash ? `stash@{${stash.index}}` : shortHash(missing)} is not in this view`);
      }
    }
    if (r.scrollAnchor === undefined && r.scrollTop === undefined && r.selectedHash === undefined)
      this.restore = undefined;
  }

  private saveState(): void {
    // While a restore is pending, keep the saved position rather than the not yet restored one.
    const state: SavedState = {
      selectedHash: this.restore?.selectedHash ?? this.selectedHash(),
      scrollAnchor: this.restore ? this.restore.scrollAnchor : this.scrollAnchor(),
      scrollTop: this.restore?.scrollTop ?? this.scroller.scrollTop,
      expanded: this.restore?.expanded ?? this.expanded,
      metaOpen: this.metaOpen,
      options: this.options,
    };
    vscode.setState(state);
    // Mirrored to the host (at most every half second): an extension host restart leaves this
    // webview behind, and the host then re-creates the panel from it.
    if (this.mirrorTimer === undefined) {
      this.mirrorTimer = setTimeout(() => {
        this.mirrorTimer = undefined;
        vscode.postMessage({ type: 'state', state: vscode.getState() });
      }, 500);
    }
  }

  /** The row at the top of the view and the offset into it; undefined with no rows. */
  private scrollAnchor(): SavedState['scrollAnchor'] {
    const top = this.scroller.scrollTop;
    const index = Math.min(this.rowFloor(top), this.list.length - 1);
    const row = this.list[index];
    return row && { hash: rowHash(row), offset: top - this.rowTop(index) };
  }

  private setStashes(stashes: StashEntry[]): void {
    this.stashes = stashes;
    this.anchors = this.options.showStashes ? anchoredAt(stashes) : new Map();
    this.updateStashButton();
  }

  /** Shows or hides the stash rows: interleaved again here, the history is not reloaded. */
  private setShowStashes(show: boolean): void {
    if (show === this.options.showStashes) return;
    this.setOptions({ ...this.options, showStashes: show });
    this.setStashes(this.stashes);
    this.relist();
  }

  /** Whether each stash's row is in the list, and if not, why. */
  private stashShown(): Record<string, StashShown> {
    const shown = (s: StashEntry): StashShown =>
      !this.options.showStashes
        ? 'hidden'
        : this.indexOf(s.hash) >= 0
          ? 'drawn'
          : this.done
            ? 'notInView'
            : 'notLoaded';
    return Object.fromEntries(this.stashes.map((s) => [s.hash, shown(s)]));
  }

  private updateStashButton(): void {
    const n = this.stashes.length;
    this.stashButton.hidden = n === 0;
    this.refFilter.updateStashes(n, this.options.showStashes);
    if (n === 0) return;
    const hidden = Object.values(this.stashShown()).filter((v) => v !== 'drawn').length;
    const label = `${n} ${n === 1 ? 'stash' : 'stashes'}${hidden > 0 ? ` · ${hidden} not shown` : ''}`;
    this.stashButton.querySelector('.stash-count')!.textContent = label;
    this.stashButton.querySelector('.stash-count-narrow')!.textContent = `${n}${hidden > 0 ? '•' : ''}`;
    this.stashButton.title = `${label}. Show Stashes`;
    this.stashButton.setAttribute('aria-label', this.stashButton.title);
  }

  /** Selects and opens a row picked from Show Stashes, showing stash rows again if they are hidden. */
  private reveal(hash: string): void {
    if (this.stashes.some((s) => s.hash === hash)) this.setShowStashes(true);
    this.selectHash(hash, true);
  }

  /**
   * Interleaves the loaded commits with the stashes again, without reloading the history. The
   * selection and the row at the top of the view stay on what they showed; when that was a stash
   * that is gone, on the row that took its place (the next stash on that commit, else the commit).
   */
  private relist(): void {
    const old = this.list;
    const top = this.scroller.scrollTop;
    const anchor = old.length > 0 ? Math.min(this.rowFloor(top), old.length - 1) : -1;
    const offset = anchor >= 0 ? top - this.rowTop(anchor) : 0;
    const was = this.selectedHash();
    this.list = [];
    this.geometry.clear();
    this.appendRows(interleave(this.commits, 0, this.anchors));
    const survivor = (i: number) => {
      for (let j = i; j < old.length; j++) {
        const k = this.indexOf(rowHash(old[j]!));
        if (k >= 0) return k;
      }
      return this.list.length - 1;
    };
    if (this.selected >= 0) this.selected = survivor(this.selected);
    this.syncSizer();
    if (anchor >= 0) this.scroller.scrollTop = this.rowTop(survivor(anchor)) + offset;
    this.updateStashButton();
    if (this.selected >= 0 && this.selectedHash() !== was && this.expanded)
      this.select(this.selected, { reveal: false });
    // Open stash details name stash@{n}, which may have been renumbered.
    else if (this.details?.stash) this.renderDetails();
    this.saveState();
    this.queueRender();
  }

  private appendRows(rows: readonly ListRow[]): void {
    this.list.push(...rows);
    for (const r of rows) this.geometry.push(r.kind === 'commit' && this.hasBadges(r.commit.hash));
  }

  /** Row index of a commit or stash; -1 when it is not in the list. */
  private indexOf(hash: string): number {
    return this.list.findIndex((r) => rowHash(r) === hash);
  }

  private selectedHash(): string | undefined {
    const row = this.list[this.selected];
    return row && rowHash(row);
  }

  /**
   * Outlines the element a context menu is open on (main.css) until VS Code closes the menu. VS
   * Code sets body.vscode-context-menu-visible for every workbench menu, so the mark goes when the
   * class does, not at the next menu.
   */
  private trackMenuTarget(): void {
    const clear = () => {
      this.menuTarget = undefined;
      for (const e of document.querySelectorAll('.menu-target')) e.classList.remove('menu-target');
    };
    document.addEventListener('contextmenu', (e) => {
      // Redirected, to the row or to an element that has a menu: the redirected event marks it.
      if (e.defaultPrevented) return;
      clear();
      const target = (e.target as Element).closest<HTMLElement>('[data-vscode-context]');
      if (!target) return;
      // VS Code would show no menu, yet report one as open until another menu closes.
      if (!MENU_SECTIONS.has(String(contextOf(target)['webviewSection']))) {
        e.preventDefault();
        target.parentElement
          ?.closest('[data-vscode-context]')
          ?.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY }),
          );
        return;
      }
      target.classList.add('menu-target');
      const row = target.closest<HTMLElement>('.row');
      if (row) this.menuTarget = { row: Number(row.dataset['index']), target: menuTargets(row).indexOf(target) };
    });
    let shown = false;
    new MutationObserver(() => {
      const now = document.body.classList.contains('vscode-context-menu-visible');
      if (shown && !now) clear();
      shown = now;
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    // Shift+F10 and the Menu key open a menu on the focused element: the list, which has no context.
    this.scroller.addEventListener('contextmenu', (e) => {
      if (e.target !== this.scroller) return;
      e.preventDefault();
      // A right-click into the empty list below the rows (button 2) opens nothing.
      if (e.button !== 2) this.openRowMenu();
    });
  }

  /** Opens the selected row's context menu below its subject, as for a right-click there. */
  private openRowMenu(): void {
    if (this.selected < 0) return;
    this.ensureVisible(this.selected);
    this.render();
    const row = this.rowsLayer.querySelector<HTMLElement>(`#row-${this.selected}`);
    const at = (row?.querySelector('.subject') ?? row)?.getBoundingClientRect();
    if (!row || !at) return;
    row.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: at.left + 4, clientY: at.bottom - 2 }),
    );
  }

  /** Re-applies the open menu's outline to a re-rendered row. */
  private markMenuTarget(row: HTMLElement, index: number): void {
    if (this.menuTarget?.row === index) menuTargets(row)[this.menuTarget.target]?.classList.add('menu-target');
  }

  /**
   * Turns hover highlights off when the pointer may have left without the webview noticing
   * (focus moves to an editor, the panel is hidden, the pointer leaves the iframe) and back on
   * at the next pointer movement.
   */
  private trackPointer(): void {
    const off = () => {
      document.body.classList.add('hover-off');
    };
    window.addEventListener('blur', off);
    document.documentElement.addEventListener('mouseleave', off);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) off();
    });
    // Chromium also sends pointermove without movement when content changes under a still
    // pointer (e.g. when the panel comes back); only a real movement turns hover back on.
    document.addEventListener('pointermove', (e) => {
      if (e.movementX !== 0 || e.movementY !== 0) document.body.classList.remove('hover-off');
    });
  }

  /**
   * Marks keyboard use (body.keyboard-nav) until the next pointer press: the list shows where
   * focus is while it is driven by keys, without a border left behind on a clicked row.
   */
  private trackInputModality(): void {
    const modifiers = new Set(['Shift', 'Control', 'Alt', 'Meta']);
    document.addEventListener(
      'keydown',
      (e) => {
        // Shortcuts (copy and the like) are not navigation.
        if (modifiers.has(e.key) || e.ctrlKey || e.metaKey || e.altKey) return;
        document.body.classList.add('keyboard-nav');
      },
      { capture: true },
    );
    // Back from another editor, the pointer is the likelier next input.
    window.addEventListener('blur', () => {
      document.body.classList.remove('keyboard-nav');
    });
    document.addEventListener(
      'pointerdown',
      () => {
        document.body.classList.remove('keyboard-nav');
      },
      { capture: true },
    );
  }

  /** Redraws the canvas at the new resolution when the window moves to a display with another pixel ratio. */
  private watchPixelRatio(): void {
    matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
      'change',
      () => {
        this.queueRender();
        this.watchPixelRatio();
        this.trackPointer();
      },
      { once: true },
    );
  }

  private setOptions(options: ViewOptions): void {
    this.clearActionError();
    this.options = options;
    this.updateOptionControls();
    this.saveState();
    vscode.postMessage({ type: 'setOptions', options });
  }

  private updateOptionControls(): void {
    this.firstParentButton.setAttribute('aria-pressed', String(this.options.firstParent));
    this.firstParentButton.classList.toggle('active', this.options.firstParent);
    this.refFilter.update(this.refs, this.options.refs);
  }

  private loadMore(count: number): void {
    if (this.loading || this.done || this.generation < 0) return;
    this.loading = true;
    vscode.postMessage({ type: 'loadMore', generation: this.generation, count });
    this.updateStatus();
  }

  /** An error from an action (opening a file, a menu command) lasts until the next action. */
  private clearActionError(): void {
    if (this.status.classList.contains('error') && this.generation >= 0) this.updateStatus();
  }

  private updateStatus(): void {
    this.status.classList.remove('error');
    this.status.classList.toggle('busy', this.busyLabel !== undefined);
    if (this.busyLabel !== undefined) {
      this.status.textContent = `${this.busyLabel}…`;
      return;
    }
    const n = this.commits.length.toLocaleString();
    this.status.textContent = this.done ? `${n} commits` : `${n}+ commits${this.loading ? ' · loading…' : ''}`;
  }

  /** Height of the space open under the selected row. */
  private gapHeight(): number {
    return this.expanded && this.selected >= 0 ? this.gap : 0;
  }

  /** Top of row `index` in list coordinates: rows below the expanded one move down by the gap. */
  private rowTop(index: number): number {
    return this.geometry.top(index) + (index > this.selected ? this.gapHeight() : 0);
  }

  /** Row at list offset `y` (clamped to [0, count]), or -1 inside the expansion. */
  private rowAt(y: number): number {
    const gap = this.gapHeight();
    const gapTop = this.geometry.top(this.selected + 1);
    if (gap === 0 || y < gapTop) return this.geometry.indexAt(y);
    if (y < gapTop + gap) return -1;
    return this.geometry.indexAt(y - gap);
  }

  /** Row at or above offset `y`; the expansion counts as part of its row. */
  private rowFloor(y: number): number {
    const r = this.rowAt(y);
    return r < 0 ? this.selected : r;
  }

  /**
   * Selects a commit. `expand` opens its details inline (default: keep the
   * current state, so arrow keys move an open expansion along). The selected
   * row keeps its place on screen when the expansion moves.
   */
  private select(index: number, opts: { reveal?: boolean; expand?: boolean } = {}): void {
    const row = this.list[index];
    if (!row) return;
    const hash = rowHash(row);
    const screenTop = this.rowTop(index) - this.scroller.scrollTop;
    this.selected = index;
    this.expanded = opts.expand ?? this.expanded;
    this.details = undefined;
    this.openedFile = undefined;
    this.foldedFolders = new Set();
    this.bodyExpanded = false;
    clearTimeout(this.copiedTimer);
    this.pendingDetails = undefined;
    if (this.expanded) {
      this.pendingDetails = hash;
      this.showLoading();
      vscode.postMessage({ type: 'select', generation: this.generation, hash });
    }
    this.syncSizer();
    this.scroller.scrollTop = this.rowTop(index) - screenTop;
    if (opts.reveal ?? true) {
      this.ensureVisible(index);
      this.revealExpansion = this.expanded;
    }
    this.saveState();
    this.queueRender();
  }

  /** Opens the details of the selected commit (Enter). */
  private expand(): void {
    if (this.selected >= 0 && !this.expanded) this.select(this.selected, { expand: true });
  }

  /**
   * A selection the user makes replaces any selection or scroll position still
   * waiting to be restored after a reload.
   */
  private userSelect(index: number, opts: { expand?: boolean } = {}): void {
    this.selections++;
    this.clearActionError();
    this.restore = undefined;
    this.select(index, opts);
  }

  /** A fold the user asks for also stops a pending restore from unfolding again. */
  private userCollapse(): void {
    this.clearActionError();
    if (this.restore) this.restore.expanded = false;
    this.collapse();
  }

  /** Folds the details away; the selection stays. */
  private collapse(): void {
    this.expanded = false;
    this.revealExpansion = false;
    this.details = undefined;
    this.pendingDetails = undefined;
    this.gap = 0;
    this.keepFocusInList(() => {
      this.expansion.hidden = true;
      this.expansion.replaceChildren();
    });
    this.expansion.style.minHeight = '';
    this.syncSizer();
    this.saveState();
    this.queueRender();
  }

  /** Placeholder while details load; keeps the previous height so moving with the arrow keys does not jump. */
  private showLoading(): void {
    this.expansion.style.minHeight = this.gap > 0 ? `${this.gap}px` : '';
    this.expansion.hidden = false;
    this.keepFocusInList(() => {
      this.expansion.replaceChildren(el('div', 'expansion-loading', 'Loading…'));
    });
    clearTimeout(this.loadingTimer);
    this.loadingTimer = setTimeout(() => {
      const loading = this.expansion.querySelector('.expansion-loading');
      if (loading && this.pendingDetails !== undefined)
        loading.textContent =
          'No answer from Strata. If it was just updated or restarted, reopen the graph (Strata: Show Commit Graph).';
    }, DETAILS_TIMEOUT_MS);
    this.placeExpansion();
    // Same height as before, so the resize observer does not run: clear the previous commit's marker.
    this.updateExpansionOverflow();
  }

  /** Runs `change` to the details; focus inside them would fall to <body>, so it goes to the list. */
  private keepFocusInList(change: () => void): void {
    const hadFocus = this.expansion.contains(document.activeElement);
    change();
    if (hadFocus) this.scroller.focus({ preventScroll: true });
  }

  /**
   * The details take at most MAX_EXPANSION_SHARE of the list, but may fill the room the rows below
   * leave empty at the end of a short history; the selected row and one more always stay in view.
   */
  private placeExpansion(): void {
    const cap = expansionCap(this.geometry, this.selected, this.scroller.clientHeight, MAX_EXPANSION_SHARE);
    this.expansion.style.top = `${this.geometry.top(this.selected + 1)}px`;
    this.expansion.style.maxHeight = `${Math.max(ROW_HEIGHT, cap)}px`;
  }

  /** Marks details that continue below their visible part, which then fade out at the bottom. */
  private updateExpansionOverflow(): void {
    const e = this.expansion;
    e.classList.toggle('more-below', e.scrollTop + e.clientHeight < e.scrollHeight - 1);
  }

  private onExpansionResize(): void {
    const h = this.expansion.hidden ? 0 : this.expansion.offsetHeight;
    if (h !== this.gap) {
      // Details opening or growing above the view (e.g. restored under a row scrolled past) would
      // push the rows in view down; keep them where they are.
      const above = this.selected >= 0 && this.geometry.top(this.selected + 1) < this.scroller.scrollTop;
      const delta = h - this.gap;
      this.gap = h;
      this.syncSizer();
      if (above) this.scroller.scrollTop += delta;
      this.queueRender();
    }
    // Also when the new details are as tall as the previous ones (no resize): reveal them once,
    // now, rather than at some later unrelated resize.
    if (this.revealExpansion && this.details) {
      this.revealExpansion = false;
      this.ensureVisible(this.selected, true);
      this.queueRender();
    }
  }

  /** The list's height must be right before scrollTop is set, or the browser clamps it. */
  private syncSizer(): void {
    this.sizer.style.height = `${this.geometry.total() + this.gapHeight()}px`;
  }

  /** Selects a commit by hash, loading further pages until it shows up (like a restore). */
  private selectHash(hash: string, expand?: boolean): void {
    this.scroller.focus();
    const index = this.indexOf(hash);
    if (index >= 0) {
      this.select(index, expand === undefined ? {} : { expand });
      return;
    }
    this.restore = { selectedHash: hash, ...(expand === undefined ? {} : { expanded: expand }) };
    this.status.textContent = `Looking for ${shortHash(hash)}…`;
    this.applyRestore();
  }

  /** Scrolls row `index` into view; with `withExpansion`, also as much of its details as fits below it. */
  private ensureVisible(index: number, withExpansion = false): void {
    const top = this.rowTop(index);
    const bottom =
      top + this.geometry.height(index) + (withExpansion && index === this.selected ? this.gapHeight() : 0);
    const view = this.scroller.clientHeight;
    if (top < this.scroller.scrollTop) this.scroller.scrollTop = top;
    else if (bottom > this.scroller.scrollTop + view) this.scroller.scrollTop = Math.min(top, bottom - view);
  }

  private onKey(e: KeyboardEvent): void {
    if (this.copyKey(e)) return;
    // Rows move under a still pointer; a hover there would follow the keys around.
    if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'Enter', 'Escape'].includes(e.key))
      document.body.classList.add('hover-off');
    const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1 };
    const delta = moves[e.key];
    const page = e.key === 'PageDown' ? 1 : e.key === 'PageUp' ? -1 : 0;
    if (delta !== undefined) {
      e.preventDefault();
      const next = Math.min(this.list.length - 1, Math.max(0, (this.selected < 0 ? -1 : this.selected) + delta));
      this.userSelect(next);
    } else if (page !== 0 && this.list.length > 0) {
      e.preventDefault();
      // Rows differ in height (refs), so a page is measured in pixels, not rows.
      const from = Math.max(0, this.selected);
      this.userSelect(pageFrom(this.geometry, from, this.scroller.clientHeight, page));
    } else if (e.key === 'Home') {
      e.preventDefault();
      this.userSelect(0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (this.expanded) this.userCollapse();
      else this.expand();
    } else if (e.key === 'Escape') {
      this.userCollapse();
    }
  }

  /**
   * Ctrl+C copies the selected row's hash, Ctrl+Shift+C its patch (Cmd on macOS); with text
   * selected in the details, VS Code copies that text instead, as anywhere else.
   */
  private copyKey(e: KeyboardEvent): boolean {
    const row = this.list[this.selected];
    if (!(isMac ? e.metaKey : e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 'c' || !row) return false;
    if ((getSelection()?.toString() ?? '') !== '') return false;
    // Kept from VS Code too, whose Ctrl+Shift+C opens an external terminal.
    e.preventDefault();
    e.stopPropagation();
    if (!e.shiftKey) this.copyHash(rowHash(row));
    // A stash's patch is not a commit's (its untracked files); there is no command for it yet.
    else if (row.kind === 'commit')
      vscode.postMessage({
        type: 'menuCommand',
        command: 'strata.commit.copyPatch',
        context: { strataHash: row.commit.hash },
      });
    return true;
  }

  private queueRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.flushRender();
    });
  }

  /** Renders now if a render is pending (the queued frame then finds nothing to do). */
  private flushRender(): void {
    if (!this.renderQueued) return;
    this.renderQueued = false;
    this.render();
  }

  private render(): void {
    const height = this.scroller.clientHeight;
    const width = this.scroller.clientWidth;
    const scrollTop = this.scroller.scrollTop;
    const first = Math.max(0, this.rowFloor(scrollTop) - OVERSCAN);
    const last = Math.min(this.list.length, this.rowFloor(scrollTop + height) + 1 + OVERSCAN);
    this.shownLanes = Math.max(this.shownLanes, lanesUsed(this.list, this.rows, this.spans, first, last));
    const share = width <= NARROW_LIST ? NARROW_GRAPH_SHARE : MAX_GRAPH_SHARE;
    const gw = Math.min(graphWidth(this.shownLanes), Math.max(graphWidth(1), Math.floor(width * share)));

    this.syncSizer();
    if (this.expanded) this.placeExpansion();
    // Not on <html>: VS Code owns its style attribute, which is observed for theme changes.
    this.root.style.setProperty('--graph-width', `${gw}px`);
    this.chooseRowColumns(width, gw);
    // The details' width follows the graph column and the scrollbar, not only the viewport.
    const widths = `${gw}:${width}`;
    if (widths !== this.laidOutWidths) {
      this.laidOutWidths = widths;
      this.layoutDetails();
    }

    const rows: HTMLElement[] = [];
    for (let i = first; i < last; i++) rows.push(this.renderRow(i));
    this.rowsLayer.replaceChildren(...rows);
    // Only point at a row that exists in the DOM.
    if (this.selected >= first && this.selected < last) {
      this.scroller.setAttribute('aria-activedescendant', `row-${this.selected}`);
    } else {
      this.scroller.removeAttribute('aria-activedescendant');
    }

    const dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = `${gw}px`;
    this.canvas.style.height = `${height}px`;
    this.canvas.width = Math.round(gw * dpr);
    this.canvas.height = Math.round(height * dpr);
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, gw, height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, gw, height);
    ctx.clip();
    drawGraph(
      ctx,
      this.list,
      this.rows,
      this.spans,
      first,
      last,
      scrollTop,
      this.theme,
      (c) => ({ head: c.hash === this.refs.head, merge: c.parents.length > 1 }),
      (i) => this.rowTop(i),
      (i) => this.geometry.height(i),
      this.gapHeight() > 0 ? { after: this.selected, height: this.gapHeight() } : undefined,
    );
    ctx.restore();
    if (graphWidth(this.shownLanes) > gw) fadeRightEdge(ctx, gw, height);
    this.renderEmpty();

    if (!this.done && !this.loading && last + LOAD_AHEAD > this.list.length) this.loadMore(NEXT_PAGE);
  }

  /** A message in place of the list when there is nothing to show. */
  private renderEmpty(): void {
    let text: string | undefined;
    if (this.commits.length === 0) {
      if (this.noRepository) text = 'No git repository in this workspace. Open a folder that contains one.';
      else if (this.done) text = this.options.refs ? 'No commits on the selected refs.' : 'No commits yet.';
    }
    this.empty.hidden = text === undefined;
    this.empty.textContent = text ?? '';
  }

  private renderRow(i: number): HTMLElement {
    const r = this.list[i]!;
    const row = el('div', 'row');
    row.id = `row-${i}`;
    row.dataset['index'] = String(i);
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(i === this.selected));
    row.setAttribute('aria-posinset', String(i + 1));
    row.setAttribute('aria-setsize', this.done ? String(this.list.length) : '-1');
    row.style.top = `${this.rowTop(i)}px`;
    if (i === this.selected) {
      // Drawn as selected only while its details are open; folded, it is just where the keys go on from.
      row.classList.add(this.expanded ? 'selected' : 'cursor');
      row.setAttribute('aria-expanded', String(this.expanded));
    }
    if (r.kind === 'stash') {
      this.fillStashRow(row, r.stash);
      this.markMenuTarget(row, i);
      return row;
    }
    const c = r.commit;
    const badges = rowBadges(c.hash, this.refsByHash.get(c.hash) ?? [], this.refs);
    const refs = badges.flatMap((b) => b.refs);
    const context: CommitContext = {
      webviewSection: 'commit',
      preventDefaultContextMenuItems: true,
      strataHash: c.hash,
      strataSubject: c.subject,
      strataIsHead: c.hash === this.refs.head,
      strataMerge: c.parents.length > 1,
      strataHasRefs: refs.length > 0,
      strataRefs: refs.join(' '),
    };
    row.setAttribute('data-vscode-context', JSON.stringify(context));
    if (badges.length > 0) {
      // Refs get a band of their own above the commit line, so the subject keeps its column.
      row.classList.add('banded');
      const band = el('span', 'refs');
      band.append(...badges.map(renderBadge));
      row.append(band);
    }
    if (c.hash === this.refs.head) row.classList.add('head');

    const subject = el('span', 'subject');
    subject.append(el('span', 'text', c.subject));
    row.append(
      el('span', 'graph-spacer'),
      subject,
      el('span', 'author', c.author),
      this.dateCell(c.authorTime),
      el('span', 'hash', shortHash(c.hash)),
    );
    row.title = `${c.subject}\n${c.author} <${c.authorEmail}>`;
    this.markMenuTarget(row, i);
    return row;
  }

  /**
   * A stash row: always one line, the stash@{n} badge inline before the message, which keeps git's
   * "On <branch>:" prefix. No author or hash; the date is when it was stashed.
   */
  private fillStashRow(row: HTMLElement, s: StashEntry): void {
    row.classList.add('stash');
    if (s.autostash) row.classList.add('autostash');
    const context: StashContext = {
      webviewSection: 'stash',
      preventDefaultContextMenuItems: true,
      strataHash: s.hash,
      strataSubject: s.message,
      strataLeftover: this.leftover?.kind === 'restoreConflicted' && this.leftover.stash.hash === s.hash,
    };
    row.setAttribute('data-vscode-context', JSON.stringify(context));
    const subject = el('span', 'subject');
    const name = badge('stash', 'git-stash', `stash@{${s.index}}`, `stash@{${s.index}}`);
    if (s.autostash) {
      name.classList.add('autostash');
      name.append(el('span', 'badge-autostash', 'autostash'));
    }
    subject.append(name);
    const { prefix, text } = stashLabel(s);
    // git's own autostash message is the word the badge already shows.
    const shown = s.autostash && text === 'autostash' ? '' : text;
    if (prefix !== undefined || shown) {
      const message = el('span', 'text');
      if (prefix !== undefined) message.append(el('span', 'stash-prefix', prefix), ' ');
      message.append(el('span', 'stash-message', shown));
      subject.append(message);
    }
    if (s.anchor.kind === 'tip')
      subject.append(el('span', 'stash-note', `based on ${shortHash(s.base)}, no longer on '${s.branch ?? ''}'`));
    // The hash is hidden; it keeps the column as wide as in commit rows, so the dates line up.
    row.append(
      el('span', 'graph-spacer'),
      subject,
      el('span', 'author'),
      this.dateCell(s.time),
      el('span', 'hash', shortHash(s.hash)),
    );
    const base = this.commits.find((c) => c.hash === s.base);
    const label = describeStash(s, { short: shortHash(s.base), subject: base?.subject }, formatDate(s.time));
    row.title = label;
    row.setAttribute('aria-label', label);
  }

  /** Widens the measured author and date widths to cover `commits`. */
  private measureTexts(commits: readonly Commit[]): void {
    this.measureContext ??= el('canvas').getContext('2d');
    const ctx = this.measureContext;
    if (!ctx) return;
    // The rows' font: they inherit it from the list.
    ctx.font = getComputedStyle(this.scroller).font;
    const w = this.textWidths;
    for (const c of commits) {
      w.author = Math.max(w.author, ctx.measureText(c.author).width);
      // Dates use tabular figures (main.css); every digit is then as wide as a 0.
      const tabular = (t: string) => ctx.measureText(t.replace(/\d/g, '0')).width;
      w.dateFull = Math.max(w.dateFull, tabular(formatDate(c.authorTime)));
      w.dateShort = Math.max(w.dateShort, tabular(formatShortDate(c.authorTime)));
    }
  }

  /**
   * Author and date columns as wide as their widest text, shown while the subject keeps
   * SUBJECT_MIN: the full date gives way to the short one, then the date goes, then the author.
   */
  private chooseRowColumns(width: number, graph: number): void {
    const gap = width <= 600 ? 8 : 12;
    const author = Math.ceil(Math.min(this.textWidths.author, AUTHOR_MAX)) + 1;
    const dateFull = Math.ceil(this.textWidths.dateFull) + 1;
    const dateShort = Math.ceil(this.textWidths.dateShort) + 1;
    const hash = this.rowsLayer.querySelector<HTMLElement>('.row:not(.stash) .hash')?.offsetWidth ?? 60;
    const choice = chooseColumns(
      { list: width, graph, author, dateFull, dateShort, hash, gap, padding: 12 },
      SUBJECT_MIN,
    );
    const style = this.root.style;
    style.setProperty('--col-gap', `${gap}px`);
    style.setProperty('--author-w', `${author}px`);
    style.setProperty('--date-w', `${choice.date === 'short' ? dateShort : dateFull}px`);
    if (choice.author === this.columns?.author && choice.date === this.columns.date) return;
    this.columns = choice;
    this.root.classList.toggle('no-author', !choice.author);
    this.root.classList.toggle('no-date', choice.date === 'none');
    this.root.classList.toggle('short-date', choice.date === 'short');
  }

  /** Full and short forms; CSS shows the one that fits the current width. */
  private dateCell(time: number): HTMLElement {
    const cell = el('span', 'date');
    cell.append(el('span', 'date-full', formatDate(time)), el('span', 'date-short', formatShortDate(time)));
    return cell;
  }

  private markOpenedFile(path: string | undefined): void {
    this.openedFile = path;
    for (const e of this.expansion.querySelectorAll<HTMLElement>('.file')) {
      e.classList.toggle('opened', path !== undefined && e.dataset['path'] === path);
    }
  }

  /** Whether a commit shows ref badges; must agree with rowBadges(). */
  private hasBadges(hash: string): boolean {
    return this.refsByHash.has(hash) || (hash === this.refs.head && this.refs.headBranch === undefined);
  }

  private renderDetails(): void {
    const d = this.details;
    if (!d) return;
    const pane = this.expansion;
    clearTimeout(this.copiedTimer);
    clearTimeout(this.metaCopiedTimer);

    const stash = d.stash && this.stashes.find((s) => s.hash === d.hash);
    // The row truncates long subjects, so the details repeat it in full.
    const [first = '', ...rest] = d.message.split('\n');
    const subject = stash ? stashLabel(stash).text : first;
    const body = rest.join('\n').trim();
    const close = el('button', 'icon-button codicon codicon-chevron-up details-fold');
    close.title = 'Fold (Esc)';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.userCollapse();
      this.scroller.focus();
    });

    // The commit's text in one column, the change in the other (side by side on wide lists).
    const main = el('div', 'details-main');
    // Carries the body font, whose 80 columns size the message column (layoutDetails).
    const ruler = el('span', 'column-ruler');
    main.append(
      ruler,
      stash ? this.stashByline(d, stash) : this.byline(d),
      stash ? this.stashMeta(d, stash) : this.metaTable(d),
      el('h2', 'details-subject', subject),
    );
    if (body) {
      const pre = el('pre', 'details-message', reflowBody(body));
      pre.id = 'details-body';
      const more = el('button', 'link-button details-more');
      more.hidden = true;
      more.setAttribute('aria-controls', pre.id);
      more.addEventListener('click', () => {
        this.bodyExpanded = !this.bodyExpanded;
        this.layoutDetails();
      });
      main.append(pre, more);
    }
    const files = el('div', 'details-files');
    const changes = { hash: d.hash, base: d.base };
    if (stash && d.stash) {
      const summary = el('div', 'files-summary', `Changes (${d.files.length})`);
      if (d.base !== undefined) summary.append(' · vs ', this.baseLink(d.base));
      files.append(summary, this.fileTree(changes, d.files, 'Changes', new Set(d.stash.staged)));
      const untracked = d.stash.untracked;
      if (untracked)
        files.append(
          el('div', 'files-summary', `Untracked (${untracked.files.length})`),
          this.fileTree({ hash: untracked.hash, base: undefined }, untracked.files, 'Untracked files'),
        );
    } else {
      files.append(this.filesSummaryLine(d), this.fileTree(changes, d.files, 'Changed files'));
    }
    const layout = el('div', 'details-layout');
    layout.append(main, files);
    pane.style.minHeight = '';
    // The fold button is positioned top right; after the content, it comes last in tab order.
    pane.replaceChildren(layout, close);
    this.applyMetaOpen();
    this.measureTree();
    pane.scrollTop = 0;
    this.placeExpansion();
    this.layoutDetails();
    this.onExpansionResize();
    this.queueRender();
  }

  /** Author, date and the short hash (click to copy) above the subject, and the meta table toggle. */
  private byline(d: CommitDetails): HTMLElement {
    const author = el('span', 'byline-author', d.author);
    author.title = `${d.author} <${d.authorEmail}>`;
    return this.bylineOf(d, 'Show commit, author, committer and parents', author, byDate('', d.authorTime));
  }

  /** "stash@{n} · stashed <date> · on <branch>", then the stash commit's short hash and the meta toggle. */
  private stashByline(d: CommitDetails, s: StashEntry): HTMLElement {
    const parts: Node[] = [el('span', 'byline-stash', `stash@{${s.index}}`), byDate('stashed ', s.time)];
    if (s.branch !== undefined) parts.push(el('span', 'byline-branch', `on ${s.branch}`));
    return this.bylineOf(d, 'Show the stash commit, its base and what was staged', ...parts);
  }

  private bylineOf(d: CommitDetails, toggleTitle: string, ...parts: Node[]): HTMLElement {
    const line = el('div', 'byline');
    const hash = el('button', 'byline-hash');
    const icon = el('span', 'codicon codicon-copy hash-icon');
    icon.setAttribute('aria-hidden', 'true');
    hash.append(el('span', 'hash-text', shortHash(d.hash)), icon);
    hash.title = `${d.hash}\nClick to copy`;
    hash.setAttribute('aria-label', `Copy full commit hash ${shortHash(d.hash)}`);
    hash.addEventListener('click', () => {
      this.copyHash(d.hash, hash);
    });
    const toggle = el('button', 'byline-toggle codicon');
    toggle.title = toggleTitle;
    toggle.setAttribute('aria-label', toggle.title);
    toggle.setAttribute('aria-controls', 'details-meta');
    toggle.addEventListener('click', () => {
      this.metaOpen = !this.metaOpen;
      this.applyMetaOpen();
      this.saveState();
      this.layoutDetails();
    });
    const sep = () => el('span', 'byline-sep', '·');
    line.append(...[...parts, hash].flatMap((p, i) => (i > 0 ? [sep(), p] : [p])), toggle);
    return line;
  }

  private applyMetaOpen(): void {
    const wrap = this.expansion.querySelector<HTMLElement>('.meta-wrap');
    const toggle = this.expansion.querySelector<HTMLElement>('.byline-toggle');
    // Folded with CSS rather than removed, so it keeps counting toward the message's width and
    // unfolding it never changes the layout.
    wrap?.classList.toggle('closed', !this.metaOpen);
    wrap?.setAttribute('aria-hidden', String(!this.metaOpen));
    toggle?.setAttribute('aria-expanded', String(this.metaOpen));
    toggle?.classList.toggle('codicon-chevron-down', this.metaOpen);
    toggle?.classList.toggle('codicon-chevron-right', !this.metaOpen);
  }

  /** Copies through the host: the clipboard API is not reliably available in webviews. */
  private copyHash(full: string, button?: HTMLElement): void {
    vscode.postMessage({ type: 'menuCommand', command: 'strata.commit.copyHash', context: { strataHash: full } });
    this.announce('Copied full commit hash');
    const text = button?.querySelector<HTMLElement>('.hash-text');
    const icon = button?.querySelector<HTMLElement>('.hash-icon');
    if (!button || !text || !icon) return;
    // Keep the width, so the toggle after the hash does not move.
    text.style.minWidth = `${text.offsetWidth}px`;
    text.textContent = 'Copied';
    icon.classList.replace('codicon-copy', 'codicon-check');
    button.classList.add('copied');
    clearTimeout(this.copiedTimer);
    this.copiedTimer = setTimeout(() => {
      text.textContent = shortHash(full);
      text.style.minWidth = '';
      icon.classList.replace('codicon-check', 'codicon-copy');
      button.classList.remove('copied');
    }, 1500);
  }

  private announce(message: string): void {
    this.announced = message;
    // Cleared first so the same message is announced again.
    this.announcer.textContent = '';
    requestAnimationFrame(() => {
      this.announcer.textContent = message;
    });
  }

  /** Commit, author and committer (both always, in full) and parents with their subjects. */
  private metaTable(d: CommitDetails): HTMLElement {
    return this.metaWrap('Commit metadata', (row) => {
      row('Commit', el('code', undefined, d.hash), this.metaCopy(d.hash));
      // Both always, in full: who wrote it and who committed it (rebases, cherry-picks, patches).
      row('Author', `${d.author} <${d.authorEmail}> · ${formatDate(d.authorTime)}`);
      row('Committer', `${d.committer} <${d.committerEmail}> · ${formatDate(d.commitTime)}`);
      d.parents.forEach((p, i) => {
        const subject = d.parentSubjects[i] ?? '';
        const link = el('button', 'link-button meta-parent');
        link.append(el('code', undefined, shortHash(p)), ` ${subject}`);
        link.title = p;
        link.setAttribute('aria-label', `Select parent ${shortHash(p)}: ${subject}`);
        link.addEventListener('click', () => {
          this.selectHash(p);
        });
        row(d.parents.length > 1 ? `${ordinal(i + 1)} parent` : 'Parent', link);
      });
    });
  }

  /**
   * The stash commit, its base (a link while the base is in the graph) and how many of its files
   * were staged.
   */
  private stashMeta(d: CommitDetails, s: StashEntry): HTMLElement {
    return this.metaWrap('Stash metadata', (row) => {
      row('Stash', el('code', undefined, d.hash), this.metaCopy(d.hash));
      const subject = d.parentSubjects[0] ?? '';
      const moved = s.anchor.kind === 'tip' ? `. No longer on '${s.branch ?? ''}'` : '';
      const base = el(this.indexOf(s.base) >= 0 ? 'button' : 'span', 'meta-parent');
      base.append(el('code', undefined, shortHash(s.base)), ` ${subject}${moved}`);
      base.title = s.base;
      if (base instanceof HTMLButtonElement) {
        base.classList.add('link-button');
        base.setAttribute('aria-label', `Select base ${shortHash(s.base)}: ${subject}${moved}`);
        base.addEventListener('click', () => {
          this.selectHash(s.base);
        });
      }
      row('Base', base);
      const staged = d.stash?.staged.length ?? 0;
      row('Staged', staged === 0 ? 'nothing' : `${staged} file${staged === 1 ? '' : 's'}`);
    });
  }

  private metaWrap(
    label: string,
    build: (row: (label: string, ...cells: (string | Node)[]) => void) => void,
  ): HTMLElement {
    const table = el('table', 'meta-table');
    table.id = 'details-meta';
    // Laid out as a grid (main.css), which drops the implicit table roles: state them.
    table.setAttribute('role', 'table');
    table.setAttribute('aria-label', label);
    const row = (label: string, ...cells: (string | Node)[]) => {
      const th = el('th', undefined, label);
      th.scope = 'row';
      th.setAttribute('role', 'rowheader');
      const td = el('td');
      td.setAttribute('role', 'cell');
      td.append(...cells);
      const tr = el('tr');
      tr.setAttribute('role', 'row');
      tr.append(th, td);
      table.append(tr);
    };
    build(row);
    const clip = el('div', 'meta-clip');
    clip.append(table);
    const wrap = el('div', 'meta-wrap');
    wrap.append(clip);
    return wrap;
  }

  private metaCopy(hash: string): HTMLElement {
    const copy = el('button', 'icon-button codicon codicon-copy meta-copy');
    copy.title = 'Copy full commit hash';
    copy.setAttribute('aria-label', copy.title);
    copy.addEventListener('click', () => {
      this.copyHash(hash);
      copy.classList.replace('codicon-copy', 'codicon-check');
      copy.classList.add('copied');
      clearTimeout(this.metaCopiedTimer);
      this.metaCopiedTimer = setTimeout(() => {
        copy.classList.replace('codicon-check', 'codicon-copy');
        copy.classList.remove('copied');
      }, 1500);
    });
    return copy;
  }

  /** "N files changed · vs <base>" (the base selects that commit), or "N files added · root commit". */
  private filesSummaryLine(d: CommitDetails): HTMLElement {
    const s = filesSummary(d);
    const line = el('div', 'files-summary', s.text);
    if (s.root) line.append(' · root commit');
    if (s.base !== undefined) line.append(` · vs ${s.baseLabel ? `${s.baseLabel} ` : ''}`, this.baseLink(s.base));
    return line;
  }

  /** The commit changed files are compared with; selects it. */
  private baseLink(target: string): HTMLElement {
    const base = el('button', 'link-button files-base', shortHash(target));
    base.title = target;
    base.setAttribute('aria-label', `Select base commit ${shortHash(target)}`);
    base.addEventListener('click', () => {
      this.selectHash(target);
    });
    return base;
  }

  /**
   * Layout CSS cannot do alone: the body clamp (whole lines, with the count of hidden lines) and
   * whether the file tree fits into columns. Runs after the details render and when the list or
   * the details change size.
   */
  private layoutDetails(): void {
    if (!this.details || !this.expanded || this.expansion.hidden) return;
    const layout = this.expansion.querySelector<HTMLElement>('.details-layout');
    const main = this.expansion.querySelector<HTMLElement>('.details-main');
    const files = this.expansion.querySelector<HTMLElement>('.details-files');
    if (!layout || !main || !files) return;
    const cap = expansionCap(this.geometry, this.selected, this.scroller.clientHeight, MAX_EXPANSION_SHARE);
    const box = getComputedStyle(this.expansion);
    // Around the content: padding and borders, which offsets (inside the top border) leave out.
    const borderTop = parseFloat(box.borderTopWidth);
    const above = parseFloat(box.paddingTop) + borderTop;
    const below = parseFloat(box.paddingBottom) + parseFloat(box.borderBottomWidth);
    // Measured unstuck: a stuck message reports its scrolled position.
    main.classList.remove('stick');

    const ruler = main.querySelector<HTMLElement>('.column-ruler');
    if (ruler) {
      const columns = this.textWidth('0'.repeat(80), getComputedStyle(ruler).font);
      layout.style.setProperty('--message-w', `${Math.ceil(columns)}px`);
    }
    // Side by side or stacked is decided by CSS from the list width alone (flex-wrap); read back.
    const stacked = files.offsetTop > main.offsetTop + 1;
    layout.classList.toggle('stacked', stacked);
    /** Top of `e` from the expansion's border edge, the edge `cap` is measured from. */
    const top = (e: HTMLElement) =>
      borderTop + layout.offsetTop + e.getBoundingClientRect().top - layout.getBoundingClientRect().top;

    const pre = this.expansion.querySelector<HTMLElement>('.details-message');
    const more = this.expansion.querySelector<HTMLElement>('.details-more');
    if (pre && more) {
      pre.classList.remove('clamped');
      pre.style.maxHeight = '';
      // Laid out with its longest label, so its height can be measured.
      more.hidden = false;
      more.textContent = 'Show more · 999 more lines';
      const line = parseFloat(getComputedStyle(pre).lineHeight) || 18;
      const total = Math.round(pre.scrollHeight / line);
      const lines = BODY_LINES;
      // Only above the files, to keep them close; beside them the details just scroll. Hiding a
      // line or two behind a link saves nothing.
      const clampable = stacked && total >= lines + 2;
      const clamped = clampable && !this.bodyExpanded;
      pre.classList.toggle('clamped', clamped);
      if (clamped) pre.style.maxHeight = `${lines * line}px`;
      pre.dataset['hiddenLines'] = String(clamped ? total - lines : 0);
      // A focused "Show less" that disappears would drop focus to <body>.
      if (!clampable && document.activeElement === more) this.scroller.focus({ preventScroll: true });
      more.hidden = !clampable;
      more.textContent = clamped ? `Show more · ${total - lines} more lines` : 'Show less';
      more.setAttribute('aria-expanded', String(!clamped));
    }

    for (const tree of files.querySelectorAll<HTMLElement>('.files')) {
      const rows = tree.querySelectorAll('li:not([hidden])').length;
      const rowHeight = tree.querySelector<HTMLElement>('li:not([hidden])')?.offsetHeight || 22;
      const area = files.clientWidth - parseFloat(getComputedStyle(files).paddingLeft);
      // A column is as wide as the widest row, within the files' room.
      const columnWidth = Math.min(Math.max(this.treeNatural, TREE_MIN), Math.floor(area));
      layout.style.setProperty('--tree-col-w', `${columnWidth}px`);
      const byWidth = Math.min(
        TREE_MAX_COLS,
        Math.max(1, Math.floor((area + TREE_COL_GAP) / (columnWidth + TREE_COL_GAP))),
      );
      // The tree's own view: the details' height from where the tree starts once the files are at
      // the top (beside the message they already are; below it, after scrolling past it).
      const view = cap - above - below - (top(tree) - top(files));
      const height = (c: number) => Math.ceil((rows * 1.1) / c) * rowHeight;
      let cols = 1;
      if (byWidth > 1 && rows >= MULTICOL_MIN_ROWS && rows <= MULTICOL_MAX_ROWS) {
        // The fewest columns that fit the view; else as many as fit across, if that is within two views.
        const fits = Array.from({ length: byWidth }, (_, i) => i + 1).find((c) => height(c) <= view);
        cols = fits ?? (height(byWidth) <= 2 * view ? byWidth : 1);
      }
      tree.style.setProperty('--cols', String(cols));
      tree.classList.toggle('files-multicol', cols > 1);
    }
    // A stuck message taller than the view would hide its own end; and once unfolded it scrolls.
    main.classList.toggle('stick', !stacked && !this.bodyExpanded && main.offsetHeight <= cap - above - below);
    this.updateExpansionOverflow();
  }

  /** Measures the trees' widest row once per commit; folding and resizing do not change it. */
  private measureTree(): void {
    this.treeNatural = 0;
    for (const tree of this.expansion.querySelectorAll<HTMLElement>('.files')) {
      tree.classList.add('measuring');
      // Rounded up: offsetWidth rounds down, which would cut the widest name by a fraction of a pixel.
      this.treeNatural = Math.max(this.treeNatural, Math.ceil(tree.getBoundingClientRect().width));
      tree.classList.remove('measuring');
    }
  }

  /**
   * The changed files as a tree (role=tree): folders fold with a click, Left/Right or Enter;
   * Up/Down move between visible entries. Folded folders are remembered per commit.
   */
  private fileTree(
    source: FileSource,
    files: readonly FileChange[],
    label: string,
    staged: ReadonlySet<string> = new Set(),
  ): HTMLElement {
    const list = el('ul', 'files');
    list.setAttribute('role', 'tree');
    list.setAttribute('aria-label', label);
    // Folds are remembered per tree: a stash's changes and its untracked files can share folders.
    list.dataset['folds'] = `${label}:`;
    const add = (nodes: FileTreeNode[], depth: number) => {
      for (const n of nodes) {
        if (n.kind === 'file') {
          list.append(this.fileItem(source, n.change, n.name, depth, staged.has(n.change.path)));
          continue;
        }
        const li = el('li', depth > 0 ? 'folder nested' : 'folder');
        li.tabIndex = 0;
        li.dataset['path'] = n.path;
        li.setAttribute('role', 'treeitem');
        li.setAttribute('aria-level', String(depth + 1));
        li.style.setProperty('--depth', String(depth));
        li.title = n.path;
        li.append(el('span', 'codicon codicon-chevron-down folder-chevron'), el('span', 'folder-name', n.name));
        li.addEventListener('click', () => {
          this.toggleFolder(list, n.path);
        });
        list.append(li);
        add(n.children, depth + 1);
      }
    };
    add(buildFileTree([...files]), 0);
    list.addEventListener('keydown', (e) => {
      this.onTreeKey(list, e);
    });
    this.applyFolds(list);
    return list;
  }

  private isFolded(list: HTMLElement, path: string): boolean {
    return this.foldedFolders.has(`${list.dataset['folds'] ?? ''}${path}`);
  }

  private toggleFolder(list: HTMLElement, path: string, fold?: boolean): void {
    const key = `${list.dataset['folds'] ?? ''}${path}`;
    const folded = fold ?? !this.foldedFolders.has(key);
    if (folded) this.foldedFolders.add(key);
    else this.foldedFolders.delete(key);
    this.applyFolds(list);
    this.layoutDetails();
  }

  /** Hides entries under folded folders and updates the chevrons. */
  private applyFolds(list: HTMLElement): void {
    const prefix = list.dataset['folds'] ?? '';
    const folded = [...this.foldedFolders].filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length));
    for (const item of list.querySelectorAll<HTMLElement>('li')) {
      const path = item.dataset['path'] ?? '';
      item.hidden = folded.some((f) => path.startsWith(`${f}/`));
      if (item.classList.contains('folder')) {
        const open = !this.isFolded(list, path);
        item.setAttribute('aria-expanded', String(open));
        item.querySelector('.folder-chevron')?.classList.toggle('codicon-chevron-right', !open);
        item.querySelector('.folder-chevron')?.classList.toggle('codicon-chevron-down', open);
      }
    }
  }

  private onTreeKey(list: HTMLElement, e: KeyboardEvent): void {
    const item = (e.target as HTMLElement).closest<HTMLElement>('li');
    if (!item) return;
    const visible = [...list.querySelectorAll<HTMLElement>('li')].filter((i) => !i.hidden);
    const at = visible.indexOf(item);
    const isFolder = item.classList.contains('folder');
    const path = item.dataset['path'] ?? '';
    const parent = () =>
      visible
        .slice(0, at)
        .reverse()
        .find((i) => i.classList.contains('folder') && path.startsWith(`${i.dataset['path']}/`));
    let next: HTMLElement | undefined;
    if (e.key === 'ArrowDown') next = visible[at + 1];
    else if (e.key === 'ArrowUp') next = visible[at - 1];
    else if (e.key === 'ArrowLeft') {
      if (isFolder && !this.isFolded(list, path)) this.toggleFolder(list, path, true);
      else next = parent();
    } else if (e.key === 'ArrowRight' && isFolder) {
      if (this.isFolded(list, path)) this.toggleFolder(list, path, false);
      else next = visible[at + 1];
    } else if (isFolder && (e.key === 'Enter' || e.key === ' ')) {
      this.toggleFolder(list, path);
    } else return;
    e.preventDefault();
    next?.focus();
  }

  private fileItem(source: FileSource, f: FileChange, name: string, depth: number, staged: boolean): HTMLElement {
    const views = fileViews(f, source.base);
    const li = el('li', `file status-${f.status}${depth > 0 ? ' nested' : ''}`);
    li.tabIndex = 0;
    li.setAttribute('role', 'treeitem');
    li.setAttribute('aria-level', String(depth + 1));
    li.style.setProperty('--depth', String(depth));
    li.dataset['path'] = f.path;
    li.dataset['views'] = views.join(' ');
    const menu = fileMenuContext(source, f, views);
    li.setAttribute('data-vscode-context', JSON.stringify(menu));
    if (f.path === this.openedFile) li.classList.add('opened');
    li.append(el('span', 'file-status', f.status));
    const label = el('span', 'file-path');
    // The folder is the tree around it; a rename also shows where the file came from.
    label.append(el('span', 'file-name', name));
    if (f.oldPath !== undefined) label.append(el('span', 'file-old', `← ${f.oldPath}`));
    li.append(label);
    if (staged) {
      const tag = el('span', 'file-staged', 'staged');
      tag.title = 'Staged when it was stashed';
      li.append(tag);
    }

    const open = (view: FileView, beside: boolean) => {
      vscode.postMessage({
        type: 'openFile',
        view,
        generation: this.generation,
        hash: source.hash,
        base: source.base,
        file: f,
        beside,
      });
    };
    // The row opens the first view that exists: the diff, or the only side an added/deleted file has.
    const primary = views[0]!;
    const actions = el('span', 'file-actions');
    for (const view of FILE_VIEW_ORDER.filter((v) => views.includes(v))) {
      const label = FILE_VIEW_LABEL[view];
      const b = el(
        'button',
        `file-action file-action-${view}${label === undefined ? ' codicon codicon-git-compare' : ''}`,
        label,
      );
      b.tabIndex = -1;
      b.setAttribute('aria-label', FILE_VIEW_TITLE[view]);
      b.title = `${FILE_VIEW_TITLE[view]} (${FILE_VIEW_KEY[view]}) · Alt: to the side`;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        open(view, e.altKey);
      });
      actions.append(b);
    }
    li.append(actions);
    li.title = `${f.path}\nClick: ${FILE_VIEW_TITLE[primary].toLowerCase()} · Alt+Click: to the side`;
    li.addEventListener('click', (e) => {
      open(primary, e.altKey);
    });
    // Arrow keys are handled by the tree (onTreeKey).
    li.addEventListener('keydown', (e) => {
      const keyed = views.find((v) => FILE_VIEW_KEY[v] === e.key.toUpperCase() && !e.ctrlKey && !e.metaKey);
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open(primary, e.altKey);
      } else if (keyed && e.key.length === 1) {
        e.preventDefault();
        open(keyed, e.altKey);
      } else if (e.code === 'KeyC' || e.key.toUpperCase() === 'C') {
        // Explorer's "Copy Relative Path" chord: Shift+Alt+C (⌥⇧⌘C on macOS).
        if (e.shiftKey && e.altKey && (e.metaKey || !isMac)) {
          e.preventDefault();
          vscode.postMessage({ type: 'menuCommand', command: 'strata.file.copyRelativePath', context: menu });
        }
      }
    });
    return li;
  }

  private probe(): ProbeState {
    // Report the DOM as it will be drawn: state changes render on the next frame, which may not
    // have come yet when the probe arrives (it did not under load, giving stale row positions).
    this.flushRender();
    return {
      generation: this.generation,
      commits: this.commits.length,
      laidOut: this.rows.length,
      done: this.done,
      selected: this.selectedHash(),
      detailsShown: this.expanded && !this.expansion.hidden ? this.details?.hash : undefined,
      visibleSubjects: [...this.rowsLayer.querySelectorAll('.row .text')].map((e) => e.textContent),
      rowHashes: Object.fromEntries(
        [...this.rowsLayer.querySelectorAll<HTMLElement>('.row')].map((r) => {
          const i = Number(r.dataset['index']);
          return [i, this.list[i] ? rowHash(this.list[i]) : ''];
        }),
      ),
      stashRows: Object.fromEntries(
        [...this.rowsLayer.querySelectorAll<HTMLElement>('.row.stash')].map((r) => [
          Number(r.dataset['index']),
          {
            badge: r.querySelector('.badge-text')?.textContent ?? '',
            text: r.querySelector('.subject')?.textContent ?? '',
            label: r.getAttribute('aria-label') ?? '',
            autostash: !!r.querySelector('.badge-stash.autostash'),
            context: JSON.parse(r.getAttribute('data-vscode-context') ?? '{}') as Record<string, unknown>,
          },
        ]),
      ),
      openedFile: this.openedFile,
      fileTree: [...this.expansion.querySelectorAll<HTMLElement>('.files li')]
        .filter((li) => !li.hidden)
        .map((li) => {
          const depth = Number(li.style.getPropertyValue('--depth') || 0);
          const text = li.classList.contains('folder')
            ? `${li.querySelector('.folder-name')?.textContent ?? ''}/`
            : (li.querySelector('.file-name')?.textContent ?? '');
          return `${'  '.repeat(depth)}${text}`;
        }),
      detailsSubject: this.expanded
        ? (this.expansion.querySelector('.details-subject')?.textContent ?? undefined)
        : undefined,
      hoverSuppressed: document.body.classList.contains('hover-off'),
      listWidth: this.scroller.clientWidth,
      menuContexts: {
        files: [...this.expansion.querySelectorAll<HTMLElement>('.file')].map(
          (li) => JSON.parse(li.getAttribute('data-vscode-context') ?? '{}') as Record<string, unknown>,
        ),
        selectedRow: (() => {
          const row = this.rowsLayer.querySelector<HTMLElement>(`#row-${this.selected}`);
          const ctx = row?.getAttribute('data-vscode-context');
          return ctx ? (JSON.parse(ctx) as Record<string, unknown>) : undefined;
        })(),
        badges: Object.fromEntries(
          [...this.rowsLayer.querySelectorAll<HTMLElement>('.row')].flatMap((r) => {
            const targets = menuTargets(r).slice(1);
            return targets.length > 0 ? [[Number(r.dataset['index']), targets.map(contextOf)]] : [];
          }),
        ),
      },
      menuTarget: (() => {
        const e = document.querySelector<HTMLElement>('.menu-target');
        return e
          ? { context: contextOf(e), text: e.textContent, outline: getComputedStyle(e).outlineStyle }
          : undefined;
      })(),
      menuShown: document.body.classList.contains('vscode-context-menu-visible'),
      fileViews: [...this.expansion.querySelectorAll<HTMLElement>('.file')].map((li) => ({
        path: li.querySelector('.file-name')?.textContent ?? '',
        views: (li.dataset['views'] ?? '').split(' ').filter(Boolean) as FileView[],
      })),
      options: this.options,
      operation: this.operation,
      expandedHeight: this.gapHeight(),
      rowTops: Object.fromEntries(
        [...this.rowsLayer.querySelectorAll<HTMLElement>('.row')].map((r) => [
          Number(r.dataset['index']),
          parseFloat(r.style.top),
        ]),
      ),
      scrollTop: this.scroller.scrollTop,
      rowHeights: Object.fromEntries(
        [...this.rowsLayer.querySelectorAll<HTMLElement>('.row')].map((r) => [
          Number(r.dataset['index']),
          r.offsetHeight,
        ]),
      ),
      refBands: Object.fromEntries(
        [...this.rowsLayer.querySelectorAll<HTMLElement>('.row:not(.stash)')].flatMap((r) => {
          const band = r.querySelector<HTMLElement>('.refs');
          const text = r.querySelector<HTMLElement>('.subject .text')!;
          const top = r.getBoundingClientRect().top;
          const els = [...r.querySelectorAll<HTMLElement>('.badge')];
          if (els.length === 0) return [];
          return [
            [
              Number(r.dataset['index']),
              {
                badges: els.map((b) => b.querySelector('.badge-text')?.textContent ?? b.textContent),
                head: els.map((b) => b.classList.contains('badge-head')),
                colors: els.map((b) => getComputedStyle(b).color),
                subjectColor: getComputedStyle(text).color,
                authorColor: getComputedStyle(r.querySelector('.author')!).color,
                badgeBottom: band ? Math.max(...els.map((b) => b.getBoundingClientRect().bottom)) - top : -1,
                subjectTop: text.getBoundingClientRect().top - top,
                subjectLeft: text.getBoundingClientRect().left,
                bandLeft: band ? band.getBoundingClientRect().left : -1,
                refNames: els.flatMap((b) => (b.dataset['refs'] ?? '').split(' ').filter(Boolean)),
              },
            ],
          ];
        }),
      ),
      details: this.probeDetails(),
      announced: this.announced,
      status: this.status.textContent,
      listBusy: this.scroller.getAttribute('aria-busy') === 'true',
      authorColumn: (() => {
        const cells = [...this.rowsLayer.querySelectorAll<HTMLElement>('.row .author')].filter(
          (c) => getComputedStyle(c).display !== 'none',
        );
        // The cell is the grid column; a range around its text gives the name's own width.
        const textWidth = (c: HTMLElement) => {
          const r = document.createRange();
          r.selectNodeContents(c);
          return r.getBoundingClientRect().width;
        };
        return {
          column: cells[0]?.getBoundingClientRect().width ?? 0,
          widestName: Math.max(0, ...cells.map(textWidth)),
        };
      })(),
      selectionShown: !!this.rowsLayer.querySelector('.row.selected'),
      stashButton: this.stashButton.hidden ? '' : (this.stashButton.querySelector('.stash-count')?.textContent ?? ''),
      idleFileActions: [...this.expansion.querySelectorAll<HTMLElement>('.file')].some(
        (f) =>
          !f.matches(':hover') &&
          !f.matches(':has(:focus-visible), :focus-visible') &&
          getComputedStyle(f.querySelector('.file-actions')!).visibility === 'visible',
      ),
      selectionOutline: (() => {
        const row = this.rowsLayer.querySelector<HTMLElement>(`#row-${this.selected}`);
        if (!row) return 'none';
        const cs = getComputedStyle(row);
        return cs.outlineColor === 'rgba(0, 0, 0, 0)' ? 'none' : cs.outlineStyle;
      })(),
      focused: (document.activeElement as HTMLElement | null)?.className ?? '',
      columns: [...(this.rowsLayer.querySelector('.row')?.children ?? [])]
        .filter((e) => !e.classList.contains('refs'))
        .filter((e) => getComputedStyle(e).display !== 'none')
        .map((e) => e.className),
    };
  }

  private probeDetails(): ProbeState['details'] {
    const e = this.expansion;
    if (!this.expanded || !this.details || e.hidden) return undefined;
    const main = e.querySelector<HTMLElement>('.details-main');
    const files = e.querySelector<HTMLElement>('.details-files');
    const table = e.querySelector<HTMLElement>('.meta-table');
    const metaOpen = !!e.querySelector('.meta-wrap:not(.closed)');
    const pre = e.querySelector<HTMLElement>('.details-message');
    const tree = e.querySelector<HTMLElement>('.files');
    const treeLeft = tree?.getBoundingClientRect().left ?? 0;
    return {
      blocks: [...e.querySelectorAll<HTMLElement>('.details-main > *, .details-files > *')]
        .filter((b) => !b.hidden && !b.classList.contains('column-ruler'))
        .map((b) => b.className),
      sideBySide:
        !!main && !!files && Math.abs(main.getBoundingClientRect().top - files.getBoundingClientRect().top) < 2,
      byline: e.querySelector('.byline')?.textContent ?? '',
      metaOpen,
      metaRows: table && metaOpen ? [...table.querySelectorAll('th')].map((th) => th.textContent) : [],
      filesSummary: e.querySelector('.files-summary')?.textContent ?? '',
      bodyClamp: {
        clamped: pre?.classList.contains('clamped') ?? false,
        hiddenLines: Number(pre?.dataset['hiddenLines'] ?? 0),
      },
      moreBelow: e.classList.contains('more-below'),
      overflowing: e.scrollTop + e.clientHeight < e.scrollHeight - 1,
      filesMulticol: e.querySelector('.files')?.classList.contains('files-multicol') ?? false,
      stacked: e.querySelector('.details-layout')?.classList.contains('stacked') ?? false,
      treeWidth: parseFloat(
        e.querySelector<HTMLElement>('.details-layout')?.style.getPropertyValue('--tree-col-w') ?? '0',
      ),
      cols: Number(tree?.style.getPropertyValue('--cols') || 1),
      actionsRight: Math.max(
        0,
        ...[...e.querySelectorAll<HTMLElement>('.file:not([hidden]) .file-actions')].map(
          (a) => a.getBoundingClientRect().right - treeLeft,
        ),
      ),
      listWidth: this.scroller.clientWidth,
      filesLeft: files && main ? files.getBoundingClientRect().left - main.getBoundingClientRect().left : 0,
      graphWidth: parseFloat(this.root.style.getPropertyValue('--graph-width')) || 0,
      layoutWidth: e.querySelector<HTMLElement>('.details-layout')?.getBoundingClientRect().width ?? 0,
      messageWidth: main?.getBoundingClientRect().width ?? 0,
      bodyColumns80: pre ? this.textWidth('0'.repeat(80), getComputedStyle(pre).font) : 0,
      bodyWraps:
        !!pre &&
        pre.scrollHeight >
          pre.textContent.split('\n').length * (parseFloat(getComputedStyle(pre).lineHeight) || 18) + 1,
    };
  }

  private textWidth(text: string, font: string): number {
    this.measureContext ??= el('canvas').getContext('2d');
    if (!this.measureContext) return 0;
    this.measureContext.font = font;
    return this.measureContext.measureText(text).width;
  }

  private simulate(a: SimulatedAction): void {
    switch (a.kind) {
      case 'clickRow': {
        // A real click hits a row on screen; scroll only when it is not.
        this.ensureVisible(a.index);
        this.render();
        // A real click carries the pointer position, which is what selection uses.
        const row = this.rowsLayer.querySelector<HTMLElement>(`#row-${a.index}`);
        if (row) {
          const r = row.getBoundingClientRect();
          // A real click starts with a pointerdown, which tells keyboard and pointer use apart.
          row.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + 40, clientY: r.top + 4 }),
          );
          // Pressing on the list focuses it (tabIndex 0), as a real mousedown does.
          this.scroller.focus({ preventScroll: true });
          row.dispatchEvent(
            new MouseEvent('click', { bubbles: true, clientX: r.left + 40, clientY: r.top + (a.y ?? r.height / 2) }),
          );
        }
        break;
      }
      case 'scrollToRow':
        this.scroller.scrollTop = this.rowTop(a.index);
        this.render();
        break;
      case 'clickFile': {
        const file = this.expansion.querySelectorAll<HTMLElement>('.file')[a.index];
        const target = a.view ? file?.querySelector<HTMLElement>(`.file-action-${a.view}`) : file;
        target?.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: a.altKey ?? false }));
        break;
      }
      case 'click':
        document.querySelector<HTMLElement>(a.selector)?.click();
        break;
      case 'focus':
        document.querySelector<HTMLElement>(a.selector)?.focus();
        break;
      case 'contextMenu': {
        const target = document.querySelector<HTMLElement>(a.selector);
        const r = target?.getBoundingClientRect();
        if (target && r) {
          target.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 60, clientY: r.top + r.height / 2 }),
          );
        }
        break;
      }
      case 'selectText': {
        const target = document.querySelector(a.selector);
        if (target) getSelection()?.selectAllChildren(target);
        else getSelection()?.removeAllRanges();
        break;
      }
      case 'keyboardContextMenu': {
        this.scroller.focus();
        const r = this.scroller.getBoundingClientRect();
        this.scroller.dispatchEvent(
          new PointerEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            button: -1,
            clientX: r.left + r.width / 2,
            clientY: r.top + r.height / 2,
          }),
        );
        break;
      }
      case 'type': {
        const input = document.querySelector<HTMLInputElement>(a.selector);
        if (input) {
          input.value = a.text;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        break;
      }
      case 'key': {
        const target =
          a.target === 'focused'
            ? document.activeElement
            : a.target === 'files'
              ? (document.activeElement?.closest('.file') ?? this.expansion.querySelector<HTMLElement>('.file'))
              : this.scroller;
        if (target instanceof HTMLElement) target.focus();
        target?.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: a.key,
            bubbles: true,
            shiftKey: a.shiftKey ?? false,
            ctrlKey: a.ctrlKey ?? false,
            altKey: a.altKey ?? false,
            metaKey: a.metaKey ?? false,
          }),
        );
        break;
      }
    }
  }
}

const isMac = navigator.platform.toUpperCase().includes('MAC');

/** The commit changed files belong to and the commit they are compared with (none: all added). */
interface FileSource {
  hash: string;
  base: string | undefined;
}

/** A details date: full and short forms, CSS shows the one that fits. */
function byDate(prefix: string, time: number): HTMLElement {
  const date = el('span', 'byline-date');
  date.append(
    el('span', 'details-date-full', `${prefix}${formatDate(time)}`),
    el('span', 'details-date-short', `${prefix}${formatShortDate(time)}`),
  );
  date.title = formatDate(time);
  return date;
}

/**
 * data-vscode-context of a changed file: VS Code merges it into the arguments of the
 * webview/context menu commands and evaluates the menu's `when` clauses against it.
 */
function fileMenuContext(source: FileSource, f: FileChange, views: FileView[]): Record<string, unknown> {
  return {
    webviewSection: 'file',
    preventDefaultContextMenuItems: true,
    strataHash: source.hash,
    ...(source.base === undefined ? {} : { strataBase: source.base }),
    strataPath: f.path,
    ...(f.oldPath === undefined ? {} : { strataOldPath: f.oldPath }),
    strataStatus: f.status,
    strataHasDiff: views.includes('diff'),
    strataHasOld: views.includes('before'),
    strataHasNew: views.includes('after'),
    strataRenamed: f.oldPath !== undefined,
  };
}

/**
 * Fades the graph out at the right edge when lanes beyond the column are cut off. It erases
 * rather than paints, so whatever is under the canvas (selection, details) shows through.
 */
function fadeRightEdge(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const fade = 16;
  const g = ctx.createLinearGradient(width - fade, 0, width, 0);
  g.addColorStop(0, 'rgba(0, 0, 0, 0)');
  g.addColorStop(1, 'rgba(0, 0, 0, 1)');
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = g;
  ctx.fillRect(width - fade, 0, fade, height);
  ctx.restore();
}

/** A badge; it and each remote name in it carry their own menu context. */
function renderBadge(b: Badge): HTMLElement {
  const e =
    b.look === 'more' ? el('span', 'badge badge-more', b.text) : badge(b.look, BADGE_ICON[b.look], b.text, b.title);
  e.title = b.title;
  e.dataset['refs'] = b.context.webviewSection === 'head' ? 'HEAD' : b.refs.join(' ');
  e.setAttribute('data-vscode-context', JSON.stringify(b.context));
  if (b.remotes.length > 0) e.append(remoteSegment(b));
  return e;
}

/** "origin, upstream +1" after a branch's name: its same-named remote-tracking branches. */
function remoteSegment(b: Badge): HTMLElement {
  const seg = el('span', 'badge-remotes');
  const icon = el('span', 'codicon codicon-cloud');
  icon.setAttribute('aria-hidden', 'true');
  const names = el('span', 'badge-remote-names');
  names.setAttribute('aria-hidden', 'true');
  b.remotes.forEach((r, i) => {
    if (i > 0) names.append(r.context.webviewSection === 'refs' ? ' ' : ', ');
    const name = el('span', 'badge-remote-name', r.text);
    name.setAttribute('data-vscode-context', JSON.stringify(r.context));
    names.append(name);
  });
  seg.append(icon, names, el('span', 'sr-only', `, also ${b.also.join(', ')}`));
  return seg;
}

/** A row and the elements in it a context menu can be opened on, in document order. */
const menuTargets = (row: HTMLElement): HTMLElement[] => [
  row,
  ...row.querySelectorAll<HTMLElement>('[data-vscode-context]'),
];

const contextOf = (e: HTMLElement) =>
  JSON.parse(e.getAttribute('data-vscode-context') ?? '{}') as Record<string, unknown>;

const ordinal = (n: number) =>
  `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

function badge(kind: string, icon: string, text: string, title: string): HTMLElement {
  const b = el('span', `badge badge-${kind}`);
  b.title = title;
  b.append(el('span', `codicon codicon-${icon}`), el('span', 'badge-text', text));
  return b;
}

/** VS Code injects theme colors as `--vscode-*` custom properties on <html>. */
function readThemeVars(): Record<string, string> {
  const style = document.documentElement.style;
  const vars: Record<string, string> = {};
  for (let i = 0; i < style.length; i++) {
    const name = style.item(i);
    if (name.startsWith('--vscode-')) vars[name] = style.getPropertyValue(name).trim();
  }
  return vars;
}

void new App(document.getElementById('app')!).boot();
