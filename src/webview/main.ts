import type { Commit } from '../core/commit.ts';
import type { CommitDetails, FileChange } from '../core/details.ts';
import type { Row } from '../core/layout.ts';
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

/** Persisted with setState: survives hiding and VS Code restarts (the panel is restored by a serializer). */
interface SavedState {
  selectedHash?: string | undefined;
  scrollTop?: number | undefined;
  /** Details pane size beside the list (px). */
  detailsWidth?: number | undefined;
  /** Details pane size below the list (px). */
  detailsHeight?: number | undefined;
  options?: ViewOptions | undefined;
}

const MIN_PANE = 120;

/** Restoring a selection loads at most this many commits looking for it. */
const RESTORE_SEARCH_LIMIT = 5000;

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
  private lanes = 1;
  private done = false;
  private loading = false;
  private selected = -1;
  private details: CommitDetails | undefined;
  private openedFile: string | undefined;

  private readonly toolbar = el('header', 'toolbar');
  private readonly repoLabel = el('span', 'repo');
  private readonly status = el('span', 'status');
  private readonly viewport = el('div', 'viewport');
  private readonly scroller = el('div', 'scroller');
  private readonly sizer = el('div', 'sizer');
  private readonly canvas = el('canvas', 'graph');
  private readonly main = el('div', 'main');
  private readonly layout = el('div', 'layout');
  private readonly splitter = el('div', 'splitter');
  private readonly detailsPane = el('section', 'details');
  private detailsWidth: number | undefined;
  private detailsHeight: number | undefined;
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
    this.scroller.append(this.sizer);
    this.viewport.append(this.scroller, this.canvas);
    this.detailsPane.hidden = true;
    this.splitter.hidden = true;
    this.splitter.setAttribute('role', 'separator');
    this.splitter.title = 'Drag to resize';
    this.layout.append(this.viewport, this.splitter, this.detailsPane);
    this.main.append(this.layout);
    root.replaceChildren(this.toolbar, this.main);
    this.detailsWidth = this.restore?.detailsWidth;
    this.detailsHeight = this.restore?.detailsHeight;
    this.applyPaneSize();
    this.splitter.addEventListener('pointerdown', (e) => {
      this.startResize(e);
    });

    this.scroller.addEventListener('scroll', () => {
      this.queueRender();
      this.saveState();
    });
    this.scroller.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.row');
      if (row) this.select(Number(row.dataset['index']));
    });
    this.scroller.addEventListener('keydown', (e) => {
      this.onKey(e);
    });
    new ResizeObserver(() => {
      this.queueRender();
    }).observe(this.viewport);
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
        if (m.generation !== this.generation) return;
        this.details = m.details;
        this.renderDetails();
        break;
      case 'noRepository':
        this.generation = -1;
        this.repoLabel.textContent = 'No git repository';
        this.status.textContent = 'Open a folder that contains a git repository.';
        this.commits = [];
        this.rows = [];
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
    this.rows.push(...m.rows);
    this.queueRender();
  }

  private reset(generation: number, repo: RepoInfo, refs: RefSnapshot, options: ViewOptions): void {
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
    this.lanes = 1;
    this.done = false;
    this.selected = -1;
    this.updateOptionControls();
    this.repoLabel.textContent = repo.name;
    this.repoLabel.title = repo.root;
    this.status.classList.remove('error');
    this.loadMore(FIRST_PAGE);
    this.closeDetails();
    this.queueRender();
  }

  /** Re-applies the saved scroll position and selection once the history containing them has loaded. */
  private applyRestore(): void {
    const r = this.restore;
    if (!r) return;
    if (r.scrollTop !== undefined && r.scrollTop <= this.commits.length * ROW_HEIGHT) {
      this.scroller.scrollTop = r.scrollTop;
      r.scrollTop = undefined;
    }
    if (r.selectedHash !== undefined) {
      const index = this.commits.findIndex((c) => c.hash === r.selectedHash);
      if (index >= 0) {
        this.select(index, false);
        r.selectedHash = undefined;
      } else if (!this.done && this.commits.length < RESTORE_SEARCH_LIMIT) {
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
      detailsWidth: this.detailsWidth,
      detailsHeight: this.detailsHeight,
      options: this.options,
    };
    vscode.setState(state);
  }

  /** The details pane sits beside the list in wide panels and below it in narrow ones (see main.css). */
  private paneBeside(): boolean {
    return getComputedStyle(this.layout).flexDirection === 'row';
  }

  private applyPaneSize(): void {
    if (this.detailsWidth !== undefined) this.main.style.setProperty('--details-width', `${this.detailsWidth}px`);
    if (this.detailsHeight !== undefined) {
      this.main.style.setProperty('--details-height', `${this.detailsHeight}px`);
      this.main.style.setProperty('--details-max-height', 'none');
    }
  }

  private startResize(e: PointerEvent): void {
    e.preventDefault();
    const beside = this.paneBeside();
    const bounds = this.layout.getBoundingClientRect();
    this.splitter.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      if (beside) {
        this.detailsWidth = Math.round(
          Math.min(bounds.width - MIN_PANE * 2, Math.max(MIN_PANE * 2, bounds.right - ev.clientX)),
        );
      } else {
        this.detailsHeight = Math.round(
          Math.min(bounds.height - MIN_PANE, Math.max(MIN_PANE, bounds.bottom - ev.clientY)),
        );
      }
      this.applyPaneSize();
      this.queueRender();
    };
    const up = () => {
      this.splitter.removeEventListener('pointermove', move);
      this.splitter.removeEventListener('pointerup', up);
      this.saveState();
    };
    this.splitter.addEventListener('pointermove', move);
    this.splitter.addEventListener('pointerup', up);
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

  private select(index: number, reveal = true): void {
    const commit = this.commits[index];
    if (!commit) return;
    this.selected = index;
    this.details = undefined;
    this.openedFile = undefined;
    vscode.postMessage({ type: 'select', generation: this.generation, hash: commit.hash });
    if (reveal) this.ensureVisible(index);
    this.saveState();
    this.queueRender();
  }

  private ensureVisible(index: number): void {
    const top = index * ROW_HEIGHT;
    const view = this.scroller.clientHeight;
    if (top < this.scroller.scrollTop) this.scroller.scrollTop = top;
    else if (top + ROW_HEIGHT > this.scroller.scrollTop + view) this.scroller.scrollTop = top + ROW_HEIGHT - view;
  }

  private onKey(e: KeyboardEvent): void {
    const page = Math.max(1, Math.floor(this.scroller.clientHeight / ROW_HEIGHT) - 1);
    const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page };
    const delta = moves[e.key];
    if (delta !== undefined) {
      e.preventDefault();
      const next = Math.min(this.commits.length - 1, Math.max(0, (this.selected < 0 ? -1 : this.selected) + delta));
      this.select(next);
    } else if (e.key === 'Home') {
      e.preventDefault();
      this.select(0);
    } else if (e.key === 'Escape') {
      this.closeDetails();
    }
  }

  private queueRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private render(): void {
    const height = this.scroller.clientHeight;
    const width = this.scroller.clientWidth;
    const scrollTop = this.scroller.scrollTop;
    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(this.commits.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
    const gw = Math.min(graphWidth(this.lanes), Math.max(graphWidth(1), Math.floor(width * MAX_GRAPH_SHARE)));

    this.sizer.style.height = `${this.commits.length * ROW_HEIGHT}px`;
    // Not on <html>: VS Code owns its style attribute, which is observed for theme changes.
    this.root.style.setProperty('--graph-width', `${gw}px`);

    const rows: HTMLElement[] = [];
    for (let i = first; i < last; i++) rows.push(this.renderRow(i));
    this.sizer.replaceChildren(...rows);
    this.scroller.setAttribute('aria-activedescendant', this.selected >= 0 ? `row-${this.selected}` : '');

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
    drawGraph(ctx, this.rows, first, last, scrollTop, this.theme, (i) => ({
      head: this.commits[i]?.hash === this.refs.head,
      merge: (this.commits[i]?.parents.length ?? 0) > 1,
    }));
    ctx.restore();

    if (!this.done && !this.loading && last + LOAD_AHEAD > this.commits.length) this.loadMore(NEXT_PAGE);
  }

  private renderRow(i: number): HTMLElement {
    const c = this.commits[i]!;
    const row = el('div', 'row');
    row.id = `row-${i}`;
    row.dataset['index'] = String(i);
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(i === this.selected));
    row.style.top = `${i * ROW_HEIGHT}px`;
    if (i === this.selected) row.classList.add('selected');
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
    const pane = this.detailsPane;
    pane.hidden = false;
    this.splitter.hidden = false;

    const [subject = '', ...rest] = d.message.split('\n');
    const body = rest.join('\n').trim();
    const header = el('div', 'details-header');
    const close = el('button', 'icon-button codicon codicon-close');
    close.title = 'Close (Esc)';
    close.addEventListener('click', () => {
      this.closeDetails();
    });
    header.append(el('h2', 'details-subject', subject), close);

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
          const index = this.commits.findIndex((c) => c.hash === p);
          if (index >= 0) this.select(index);
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
    const children: HTMLElement[] = [header, meta, summary, files];
    if (body) children.push(el('pre', 'details-message', body));
    pane.replaceChildren(...children);
    this.queueRender();
  }

  private fileItem(d: CommitDetails, f: FileChange): HTMLElement {
    const li = el('li', `file status-${f.status}`);
    li.tabIndex = 0;
    li.setAttribute('role', 'option');
    if (f.path === this.openedFile) li.classList.add('opened');
    li.append(el('span', 'file-status', f.status));
    const name = el('span', 'file-path');
    const slash = f.path.lastIndexOf('/');
    if (f.oldPath !== undefined) name.append(el('span', 'file-old', f.oldPath), ' → ');
    // File name first: in a narrow pane the directory is what gets truncated.
    name.append(el('span', 'file-name', f.path.slice(slash + 1)));
    if (slash >= 0) name.append(el('span', 'file-dir', f.path.slice(0, slash)));
    li.append(name);
    li.title = `${f.path}\nClick: open diff · Alt+Click: open to the side`;
    const open = (beside: boolean) => {
      this.openedFile = f.path;
      for (const e of li.parentElement?.children ?? []) e.classList.toggle('opened', e === li);
      vscode.postMessage({
        type: 'openDiff',
        generation: this.generation,
        hash: d.hash,
        base: d.base,
        file: f,
        beside,
      });
    };
    li.addEventListener('click', (e) => {
      open(e.altKey);
    });
    li.addEventListener('keydown', (e) => {
      const sibling = (
        e.key === 'ArrowDown' ? li.nextElementSibling : e.key === 'ArrowUp' ? li.previousElementSibling : null
      ) as HTMLElement | null;
      if (sibling) {
        e.preventDefault();
        sibling.focus();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open(e.altKey);
      } else if (e.key === 'Escape') {
        this.scroller.focus();
      }
    });
    return li;
  }

  private closeDetails(): void {
    this.details = undefined;
    this.detailsPane.hidden = true;
    this.splitter.hidden = true;
    this.detailsPane.replaceChildren();
  }

  private probe(): ProbeState {
    return {
      generation: this.generation,
      commits: this.commits.length,
      laidOut: this.rows.length,
      done: this.done,
      selected: this.commits[this.selected]?.hash,
      detailsShown: this.detailsPane.hidden ? undefined : this.details?.hash,
      visibleSubjects: [...this.sizer.querySelectorAll('.row .text')].map((e) => e.textContent),
      openedFile: this.openedFile,
      options: this.options,
      columns: [...(this.sizer.querySelector('.row')?.children ?? [])]
        .filter((e) => getComputedStyle(e).display !== 'none')
        .map((e) => e.className),
    };
  }

  private simulate(a: SimulatedAction): void {
    switch (a.kind) {
      case 'clickRow': {
        this.scroller.scrollTop = Math.max(0, a.index * ROW_HEIGHT - ROW_HEIGHT * 3);
        this.render();
        this.sizer.querySelector<HTMLElement>(`#row-${a.index}`)?.click();
        break;
      }
      case 'clickFile': {
        const files = this.detailsPane.querySelectorAll<HTMLElement>('.file');
        files[a.index]?.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: a.altKey ?? false }));
        break;
      }
      case 'click':
        document.querySelector<HTMLElement>(a.selector)?.click();
        break;
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
            ? (document.activeElement?.closest('.file') ?? this.detailsPane.querySelector<HTMLElement>('.file'))
            : this.scroller;
        if (target instanceof HTMLElement) target.focus();
        target?.dispatchEvent(new KeyboardEvent('keydown', { key: a.key, bubbles: true }));
        break;
      }
    }
  }
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
