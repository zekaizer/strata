import type { Commit } from '../core/commit.ts';
import { fileViews, type CommitDetails, type FileChange, type FileView } from '../core/details.ts';
import { SpanIndex, type Row } from '../core/layout.ts';
import type { Ref, RefSnapshot } from '../core/refs.ts';
import { DEFAULT_OPTIONS } from '../shared/protocol.ts';
import type {
  FromWorker,
  HostToWebview,
  ProbeState,
  RepoInfo,
  SimulatedAction,
  ViewOptions,
} from '../shared/protocol.ts';
import { el, formatDate, formatShortDate, shortHash } from './format.ts';
import { drawGraph, graphWidth, ROW_HEIGHT, rowWidth } from './graph.ts';
import { RefFilter } from './ref-filter.ts';
import { resolveGraphTheme, type GraphTheme } from './theme.ts';
import { vscode } from './vscode.ts';
import { ping, startWorker } from './worker-client.ts';

const FIRST_PAGE = 300;
const NEXT_PAGE = 1000;
/** Load more once the viewport is this many rows from the end of the loaded history. */
const LOAD_AHEAD = 200;
const OVERSCAN = 8;
const MAX_GRAPH_SHARE = 0.4;
const MAX_BADGES = 3;
/** The inline details never take more than this share of the list height. */
const MAX_EXPANSION_SHARE = 0.45;

/** Persisted with setState: survives hiding and VS Code restarts (the panel is restored by a serializer). */
interface SavedState {
  selectedHash?: string | undefined;
  scrollTop?: number | undefined;
  /** Set when a scroll position was restored together with the selection; do not scroll to the selection. */
  keepScroll?: boolean | undefined;
  /** Whether the selected commit's details were expanded. */
  expanded?: boolean | undefined;
  options?: ViewOptions | undefined;
}

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

const REF_ORDER: Record<Ref['kind'], number> = { branch: 0, remote: 1, tag: 2, stash: 3 };
const REF_ICON: Record<Ref['kind'], string> = { branch: 'git-branch', remote: 'cloud', tag: 'tag', stash: 'archive' };

class App {
  private worker: Worker | undefined;
  private theme: GraphTheme = resolveGraphTheme();

  private generation = -1;
  private repo: RepoInfo | undefined;
  private refs: RefSnapshot = { head: undefined, headBranch: undefined, refs: [] };
  private refsByHash = new Map<string, Ref[]>();
  // Declared before `options`, which is initialized from it.
  private restore: SavedState | undefined = vscode.getState() as SavedState | undefined;
  private options: ViewOptions = this.restore?.options ?? DEFAULT_OPTIONS;
  private readonly refFilter: RefFilter;
  private readonly firstParentButton = el('button', 'tool-button first-parent-button');
  private commits: Commit[] = [];
  private rows: Row[] = [];
  private readonly spans = new SpanIndex();
  private lanes = 1;
  private done = false;
  private loading = false;
  private selected = -1;
  private details: CommitDetails | undefined;
  /** Commit whose details were last requested; replies for any other commit are stale. */
  private pendingDetails: string | undefined;
  private openedFile: string | undefined;

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
    this.refFilter = new RefFilter(this.toolbar, (refs) => {
      this.setOptions({ ...this.options, refs });
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
    this.sizer.append(this.rowsLayer, this.expansion);
    this.scroller.append(this.sizer);
    this.viewport.append(this.scroller, this.canvas);
    root.replaceChildren(this.toolbar, this.viewport);
    new ResizeObserver(() => {
      this.onExpansionResize();
    }).observe(this.expansion);

    this.scroller.addEventListener('scroll', () => {
      this.queueRender();
      this.saveState();
    });
    // Rows are rebuilt on every render, so the clicked element may be gone by mouseup; use the position.
    this.scroller.addEventListener('click', (e) => {
      if (this.expansion.contains(e.target as Node)) return;
      const top = this.scroller.getBoundingClientRect().top;
      const index = this.rowAt(e.clientY - top + this.scroller.scrollTop);
      if (index < 0 || index >= this.commits.length) return;
      // Clicking the expanded row folds it; any other row opens its details.
      if (index === this.selected && this.expanded) this.userCollapse();
      else this.userSelect(index, { expand: true });
    });
    this.scroller.addEventListener('keydown', (e) => {
      this.onKey(e);
    });
    new ResizeObserver(() => {
      this.queueRender();
    }).observe(this.viewport);
    this.watchPixelRatio();
    // VS Code rewrites the theme variables on <html> when the color theme changes.
    new MutationObserver(() => {
      this.theme = resolveGraphTheme();
      this.queueRender();
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
        this.reset(m.generation, m.repo, m.refs, m.options);
        break;
      case 'commits':
        if (m.generation !== this.generation) return;
        this.loading = false;
        this.done = m.done;
        this.commits.push(...m.commits);
        this.worker?.postMessage({
          type: 'layout',
          generation: m.generation,
          commits: m.commits.map((c) => ({ hash: c.hash, parents: c.parents })),
        });
        this.updateStatus();
        this.applyRestore();
        this.queueRender();
        break;
      case 'details':
        if (m.generation !== this.generation || m.details.hash !== this.pendingDetails || !this.expanded) return;
        this.pendingDetails = undefined;
        this.details = m.details;
        this.renderDetails();
        break;
      case 'noRepository':
        this.generation = -1;
        this.repoLabel.textContent = 'No git repository';
        this.status.textContent = 'Open a folder that contains a git repository.';
        this.commits = [];
        this.rows = [];
        this.spans.clear();
        this.queueRender();
        break;
      case 'error':
        this.loading = false;
        this.status.textContent = m.message;
        this.status.classList.add('error');
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
    for (const r of m.rows) this.lanes = Math.max(this.lanes, rowWidth(r));
    this.lanes = Math.max(this.lanes, m.state.lanes.length);
    this.rows.push(...m.rows);
    this.spans.add(m.spans);
    this.spans.setOpen(m.state);
    this.queueRender();
  }

  private reset(generation: number, repo: RepoInfo, refs: RefSnapshot, options: ViewOptions): void {
    // A reload of the same repository (refs changed, refresh, filters) keeps the selection, and the
    // scroll position too when the history itself is the same view.
    if (this.restore === undefined && this.repo?.root === repo.root) {
      const sameView = JSON.stringify(options) === JSON.stringify(this.options);
      this.restore = {
        selectedHash: this.commits[this.selected]?.hash,
        scrollTop: sameView ? this.scroller.scrollTop : undefined,
        expanded: this.expanded,
      };
    }
    this.generation = generation;
    this.repo = repo;
    this.refs = refs;
    this.options = options;
    this.refsByHash = new Map();
    for (const r of [...refs.refs].sort(
      (a, b) => REF_ORDER[a.kind] - REF_ORDER[b.kind] || a.short.localeCompare(b.short),
    )) {
      const list = this.refsByHash.get(r.hash) ?? [];
      list.push(r);
      this.refsByHash.set(r.hash, list);
    }
    this.commits = [];
    this.rows = [];
    this.spans.clear();
    this.lanes = 1;
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
    if (r.scrollTop !== undefined) r.keepScroll = true;
    const searchable = !this.done && this.commits.length < RESTORE_SEARCH_LIMIT;
    if (r.scrollTop !== undefined) {
      // The sizer normally grows in the next render; it must be tall enough now or the browser clamps scrollTop.
      this.syncSizer();
      this.scroller.scrollTop = r.scrollTop;
      if (Math.abs(this.scroller.scrollTop - r.scrollTop) < 1 || !searchable) r.scrollTop = undefined;
      else this.loadMore(NEXT_PAGE);
    }
    if (r.selectedHash !== undefined) {
      const index = this.commits.findIndex((c) => c.hash === r.selectedHash);
      if (index >= 0) {
        // Reveal it only when no scroll position is being restored with it. Older saved states have no
        // `expanded`; a selection then meant visible details.
        this.select(index, { reveal: r.scrollTop === undefined && !r.keepScroll, expand: r.expanded ?? true });
        r.selectedHash = undefined;
      } else if (searchable) {
        this.loadMore(NEXT_PAGE);
      } else {
        r.selectedHash = undefined;
      }
    }
    if (r.scrollTop === undefined && r.selectedHash === undefined) this.restore = undefined;
  }

  private saveState(): void {
    // While a restore is pending, keep the saved position rather than the not yet restored one.
    const state: SavedState = {
      selectedHash: this.restore?.selectedHash ?? this.commits[this.selected]?.hash,
      scrollTop: this.restore?.scrollTop ?? this.scroller.scrollTop,
      expanded: this.restore?.expanded ?? this.expanded,
      options: this.options,
    };
    vscode.setState(state);
  }

  /** Redraws the canvas at the new resolution when the window moves to a display with another pixel ratio. */
  private watchPixelRatio(): void {
    matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
      'change',
      () => {
        this.queueRender();
        this.watchPixelRatio();
      },
      { once: true },
    );
  }

  private setOptions(options: ViewOptions): void {
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

  private updateStatus(): void {
    const n = this.commits.length.toLocaleString();
    this.status.textContent = this.done ? `${n} commits` : `${n}+ commits${this.loading ? ' · loading…' : ''}`;
  }

  /** Height of the space open under the selected row. */
  private gapHeight(): number {
    return this.expanded && this.selected >= 0 ? this.gap : 0;
  }

  /** Top of row `index` in list coordinates: rows below the expanded one move down by the gap. */
  private rowTop(index: number): number {
    return index * ROW_HEIGHT + (index > this.selected ? this.gapHeight() : 0);
  }

  /** Row at list offset `y`, or -1 inside the expansion. */
  private rowAt(y: number): number {
    const gap = this.gapHeight();
    const gapTop = (this.selected + 1) * ROW_HEIGHT;
    if (gap === 0 || y < gapTop) return Math.floor(y / ROW_HEIGHT);
    if (y < gapTop + gap) return -1;
    return Math.floor((y - gap) / ROW_HEIGHT);
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
    const commit = this.commits[index];
    if (!commit) return;
    const screenTop = this.rowTop(index) - this.scroller.scrollTop;
    this.selected = index;
    this.expanded = opts.expand ?? this.expanded;
    this.details = undefined;
    this.openedFile = undefined;
    this.pendingDetails = undefined;
    if (this.expanded) {
      this.pendingDetails = commit.hash;
      this.showLoading();
      vscode.postMessage({ type: 'select', generation: this.generation, hash: commit.hash });
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
    this.restore = undefined;
    this.select(index, opts);
  }

  /** A fold the user asks for also stops a pending restore from unfolding again. */
  private userCollapse(): void {
    if (this.restore) this.restore.expanded = false;
    this.collapse();
  }

  /** Folds the details away; the selection stays. */
  private collapse(): void {
    this.expanded = false;
    this.details = undefined;
    this.pendingDetails = undefined;
    this.gap = 0;
    this.expansion.hidden = true;
    this.expansion.replaceChildren();
    this.expansion.style.minHeight = '';
    this.syncSizer();
    this.saveState();
    this.queueRender();
  }

  /** Placeholder while details load; keeps the previous height so moving with the arrow keys does not jump. */
  private showLoading(): void {
    this.expansion.style.minHeight = this.gap > 0 ? `${this.gap}px` : '';
    this.expansion.hidden = false;
    this.expansion.replaceChildren(el('div', 'expansion-loading', 'Loading…'));
    this.placeExpansion();
  }

  private placeExpansion(): void {
    this.expansion.style.top = `${(this.selected + 1) * ROW_HEIGHT}px`;
    this.expansion.style.maxHeight = `${Math.floor(this.scroller.clientHeight * MAX_EXPANSION_SHARE)}px`;
  }

  private onExpansionResize(): void {
    const h = this.expansion.hidden ? 0 : this.expansion.offsetHeight;
    if (h === this.gap) return;
    this.gap = h;
    this.syncSizer();
    if (this.revealExpansion && this.details) {
      this.revealExpansion = false;
      this.ensureVisible(this.selected, true);
    }
    this.queueRender();
  }

  /** The list's height must be right before scrollTop is set, or the browser clamps it. */
  private syncSizer(): void {
    this.sizer.style.height = `${this.commits.length * ROW_HEIGHT + this.gapHeight()}px`;
  }

  /** Selects a commit by hash, loading further pages until it shows up (like a restore). */
  private selectHash(hash: string): void {
    this.scroller.focus();
    const index = this.commits.findIndex((c) => c.hash === hash);
    if (index >= 0) {
      this.select(index);
      return;
    }
    this.restore = { selectedHash: hash };
    this.status.textContent = `Looking for ${shortHash(hash)}…`;
    this.applyRestore();
  }

  /** Scrolls row `index` into view; with `withExpansion`, also as much of its details as fits below it. */
  private ensureVisible(index: number, withExpansion = false): void {
    const top = this.rowTop(index);
    const bottom = top + ROW_HEIGHT + (withExpansion && index === this.selected ? this.gapHeight() : 0);
    const view = this.scroller.clientHeight;
    if (top < this.scroller.scrollTop) this.scroller.scrollTop = top;
    else if (bottom > this.scroller.scrollTop + view) this.scroller.scrollTop = Math.min(top, bottom - view);
  }

  private onKey(e: KeyboardEvent): void {
    const page = Math.max(1, Math.floor(this.scroller.clientHeight / ROW_HEIGHT) - 1);
    const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page };
    const delta = moves[e.key];
    if (delta !== undefined) {
      e.preventDefault();
      const next = Math.min(this.commits.length - 1, Math.max(0, (this.selected < 0 ? -1 : this.selected) + delta));
      this.userSelect(next);
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
    const last = Math.min(this.commits.length, this.rowFloor(scrollTop + height) + 1 + OVERSCAN);
    const gw = Math.min(graphWidth(this.lanes), Math.max(graphWidth(1), Math.floor(width * MAX_GRAPH_SHARE)));

    this.syncSizer();
    if (this.expanded) this.placeExpansion();
    // Not on <html>: VS Code owns its style attribute, which is observed for theme changes.
    this.root.style.setProperty('--graph-width', `${gw}px`);

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
      this.rows,
      this.spans,
      first,
      last,
      scrollTop,
      this.theme,
      (i) => ({
        head: this.commits[i]?.hash === this.refs.head,
        merge: (this.commits[i]?.parents.length ?? 0) > 1,
      }),
      (i) => this.rowTop(i),
      this.gapHeight() > 0 ? { after: this.selected, height: this.gapHeight() } : undefined,
    );
    ctx.restore();
    if (graphWidth(this.lanes) > gw) fadeRightEdge(ctx, gw, height, this.theme.background);

    if (!this.done && !this.loading && last + LOAD_AHEAD > this.commits.length) this.loadMore(NEXT_PAGE);
  }

  private renderRow(i: number): HTMLElement {
    const c = this.commits[i]!;
    const row = el('div', 'row');
    row.id = `row-${i}`;
    row.dataset['index'] = String(i);
    row.setAttribute('role', 'option');
    row.setAttribute(
      'data-vscode-context',
      JSON.stringify({
        webviewSection: 'commit',
        preventDefaultContextMenuItems: true,
        strataHash: c.hash,
        strataSubject: c.subject,
      }),
    );
    row.setAttribute('aria-selected', String(i === this.selected));
    row.setAttribute('aria-posinset', String(i + 1));
    row.setAttribute('aria-setsize', this.done ? String(this.commits.length) : '-1');
    row.style.top = `${this.rowTop(i)}px`;
    if (i === this.selected) {
      row.classList.add('selected');
      row.setAttribute('aria-expanded', String(this.expanded));
    }
    if (c.hash === this.refs.head) row.classList.add('head');

    const subject = el('span', 'subject');
    for (const b of this.badges(c.hash)) subject.append(b);
    subject.append(el('span', 'text', c.subject));
    row.append(
      el('span', 'graph-spacer'),
      subject,
      el('span', 'author', c.author),
      this.dateCell(c.authorTime),
      el('span', 'hash', shortHash(c.hash)),
    );
    row.title = `${c.subject}\n${c.author} <${c.authorEmail}>`;
    return row;
  }

  /** Full and short forms; CSS shows the one that fits the current width. */
  private dateCell(time: number): HTMLElement {
    const cell = el('span', 'date');
    cell.append(el('span', 'date-full', formatDate(time)), el('span', 'date-short', formatShortDate(time)));
    return cell;
  }

  private badges(hash: string): HTMLElement[] {
    const out: HTMLElement[] = [];
    const refs = this.refsByHash.get(hash) ?? [];
    if (hash === this.refs.head && this.refs.headBranch === undefined)
      out.push(badge('head', 'target', 'HEAD', 'Detached HEAD'));
    for (const r of refs) {
      const isHead = r.kind === 'branch' && r.short === this.refs.headBranch;
      out.push(badge(isHead ? 'head' : r.kind, isHead ? 'target' : REF_ICON[r.kind], r.short, r.name));
    }
    // Current branch first; beyond MAX_BADGES the rest collapse so the subject stays visible.
    out.sort((a, b) => Number(b.classList.contains('head')) - Number(a.classList.contains('head')));
    if (out.length <= MAX_BADGES) return out;
    const rest = out.slice(MAX_BADGES - 1);
    const more = el('span', 'badge badge-more', `+${rest.length}`);
    more.title = rest.map((b) => b.title).join('\n');
    return [...out.slice(0, MAX_BADGES - 1), more];
  }

  private renderDetails(): void {
    const d = this.details;
    if (!d) return;
    const pane = this.expansion;

    // The subject is already on the row above; only the body is shown here.
    const body = d.message.split('\n').slice(1).join('\n').trim();
    const close = el('button', 'icon-button codicon codicon-chevron-up details-fold');
    close.title = 'Fold (Esc)';
    close.addEventListener('click', () => {
      this.userCollapse();
      this.scroller.focus();
    });

    // One compact line: files are what people come here for, so they come right after it.
    const meta = el('div', 'details-meta');
    const hash = el('span', 'details-hash', shortHash(d.hash));
    hash.title = d.hash;
    meta.append(hash, el('span', 'details-author', d.author), el('span', 'details-date', formatDate(d.authorTime)));
    meta.title =
      `Author: ${d.author} <${d.authorEmail}>, ${formatDate(d.authorTime)}` +
      (d.committer !== d.author || d.commitTime !== d.authorTime
        ? `\nCommitter: ${d.committer} <${d.committerEmail}>, ${formatDate(d.commitTime)}`
        : '');
    if (d.parents.length > 0) {
      const parents = el('span', 'details-parents');
      parents.append(el('span', 'codicon codicon-git-commit'));
      for (const p of d.parents) {
        const link = el('a', 'parent', shortHash(p));
        link.href = '#';
        link.title = `Select parent ${p}`;
        link.addEventListener('click', (e) => {
          e.preventDefault();
          this.selectHash(p);
        });
        parents.append(link);
      }
      meta.append(parents);
    }

    const files = el('ul', 'files');
    files.setAttribute('role', 'listbox');
    files.setAttribute('aria-label', 'Changed files');
    for (const f of d.files) files.append(this.fileItem(d, f));
    const summary = el(
      'div',
      'files-summary',
      `${d.files.length} file${d.files.length === 1 ? '' : 's'} changed${d.base ? ` vs ${shortHash(d.base)}` : ''}`,
    );
    const children: HTMLElement[] = [close, meta, summary, files];
    if (body) children.push(el('pre', 'details-message', body));
    pane.style.minHeight = '';
    pane.replaceChildren(...children);
    pane.scrollTop = 0;
    this.placeExpansion();
    this.queueRender();
  }

  private fileItem(d: CommitDetails, f: FileChange): HTMLElement {
    const views = fileViews(f, d.base);
    const li = el('li', `file status-${f.status}`);
    li.tabIndex = 0;
    li.setAttribute('role', 'option');
    li.dataset['views'] = views.join(' ');
    const menu = fileMenuContext(d, f, views);
    li.setAttribute('data-vscode-context', JSON.stringify(menu));
    if (f.path === this.openedFile) li.classList.add('opened');
    li.append(el('span', 'file-status', f.status));
    const name = el('span', 'file-path');
    const slash = f.path.lastIndexOf('/');
    if (f.oldPath !== undefined) name.append(el('span', 'file-old', f.oldPath), ' → ');
    // File name first: in a narrow pane the directory is what gets truncated.
    name.append(el('span', 'file-name', f.path.slice(slash + 1)));
    if (slash >= 0) name.append(el('span', 'file-dir', f.path.slice(0, slash)));
    li.append(name);

    const open = (view: FileView, beside: boolean) => {
      this.openedFile = f.path;
      for (const e of li.parentElement?.children ?? []) e.classList.toggle('opened', e === li);
      vscode.postMessage({
        type: 'openFile',
        view,
        generation: this.generation,
        hash: d.hash,
        base: d.base,
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
    li.addEventListener('keydown', (e) => {
      const sibling = (
        e.key === 'ArrowDown' ? li.nextElementSibling : e.key === 'ArrowUp' ? li.previousElementSibling : null
      ) as HTMLElement | null;
      const keyed = views.find((v) => FILE_VIEW_KEY[v] === e.key.toUpperCase() && !e.ctrlKey && !e.metaKey);
      if (sibling) {
        e.preventDefault();
        sibling.focus();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open(primary, e.altKey);
      } else if (keyed && e.key.length === 1) {
        e.preventDefault();
        open(keyed, e.altKey);
      } else if (e.key === 'Escape') {
        this.scroller.focus();
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
      selected: this.commits[this.selected]?.hash,
      detailsShown: this.expanded && !this.expansion.hidden ? this.details?.hash : undefined,
      visibleSubjects: [...this.rowsLayer.querySelectorAll('.row .text')].map((e) => e.textContent),
      openedFile: this.openedFile,
      menuContexts: {
        files: [...this.expansion.querySelectorAll<HTMLElement>('.file')].map(
          (li) => JSON.parse(li.getAttribute('data-vscode-context') ?? '{}') as Record<string, unknown>,
        ),
        selectedRow: (() => {
          const row = this.rowsLayer.querySelector<HTMLElement>(`#row-${this.selected}`);
          const ctx = row?.getAttribute('data-vscode-context');
          return ctx ? (JSON.parse(ctx) as Record<string, unknown>) : undefined;
        })(),
      },
      fileViews: [...this.expansion.querySelectorAll<HTMLElement>('.file')].map((li) => ({
        path: li.querySelector('.file-name')?.textContent ?? '',
        views: (li.dataset['views'] ?? '').split(' ').filter(Boolean) as FileView[],
      })),
      options: this.options,
      expandedHeight: this.gapHeight(),
      rowTops: Object.fromEntries(
        [...this.rowsLayer.querySelectorAll<HTMLElement>('.row')].map((r) => [
          Number(r.dataset['index']),
          parseFloat(r.style.top),
        ]),
      ),
      columns: [...(this.rowsLayer.querySelector('.row')?.children ?? [])]
        .filter((e) => getComputedStyle(e).display !== 'none')
        .map((e) => e.className),
    };
  }

  private simulate(a: SimulatedAction): void {
    switch (a.kind) {
      case 'clickRow': {
        this.scroller.scrollTop = Math.max(0, this.rowTop(a.index) - ROW_HEIGHT * 3);
        this.render();
        // A real click carries the pointer position, which is what selection uses.
        const row = this.rowsLayer.querySelector<HTMLElement>(`#row-${a.index}`);
        if (row) {
          const r = row.getBoundingClientRect();
          row.dispatchEvent(
            new MouseEvent('click', { bubbles: true, clientX: r.left + 40, clientY: r.top + r.height / 2 }),
          );
        }
        break;
      }
      case 'clickFile': {
        const file = this.expansion.querySelectorAll<HTMLElement>('.file')[a.index];
        const target = a.view ? file?.querySelector<HTMLElement>(`.file-action-${a.view}`) : file;
        target?.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: a.altKey ?? false }));
        break;
      }
      case 'click':
        document.querySelector<HTMLElement>(a.selector)?.click();
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
          a.target === 'files'
            ? (document.activeElement?.closest('.file') ?? this.expansion.querySelector<HTMLElement>('.file'))
            : this.scroller;
        if (target instanceof HTMLElement) target.focus();
        target?.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: a.key,
            bubbles: true,
            shiftKey: a.shiftKey ?? false,
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

/**
 * data-vscode-context of a changed file: VS Code merges it into the arguments of the
 * webview/context menu commands and evaluates the menu's `when` clauses against it.
 */
function fileMenuContext(d: CommitDetails, f: FileChange, views: FileView[]): Record<string, unknown> {
  return {
    webviewSection: 'file',
    preventDefaultContextMenuItems: true,
    strataHash: d.hash,
    ...(d.base === undefined ? {} : { strataBase: d.base }),
    strataPath: f.path,
    ...(f.oldPath === undefined ? {} : { strataOldPath: f.oldPath }),
    strataStatus: f.status,
    strataHasDiff: views.includes('diff'),
    strataHasOld: views.includes('before'),
    strataHasNew: views.includes('after'),
    strataRenamed: f.oldPath !== undefined,
  };
}

/** Fades the graph out at the right edge when lanes beyond the column are cut off. */
function fadeRightEdge(ctx: CanvasRenderingContext2D, width: number, height: number, background: string): void {
  const fade = 16;
  const g = ctx.createLinearGradient(width - fade, 0, width, 0);
  g.addColorStop(0, `${background}00`);
  g.addColorStop(1, background);
  ctx.fillStyle = g;
  ctx.fillRect(width - fade, 0, fade, height);
}

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
