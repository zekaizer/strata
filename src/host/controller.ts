import { basename, posix } from 'node:path';
import * as vscode from 'vscode';
import type { RefSnapshot } from '../core/refs.ts';
import { hasCommitGraph, writeCommitGraph } from '../git/commit-graph.ts';
import { fileViews } from '../core/details.ts';
import { isCommitId, readCommitDetails } from '../git/details.ts';
import { LogReader } from '../git/log-reader.ts';
import { readRefs } from '../git/refs.ts';
import { DEFAULT_OPTIONS, type HostToWebview, type ViewOptions, type WebviewToHost } from '../shared/protocol.ts';
import type { GitApi, GitRepository } from './git-api.ts';

const REFRESH_DEBOUNCE_MS = 400;
/** A first page slower than this suggests writing a commit-graph (git's topological walk reads all history without one). */
const SLOW_FIRST_PAGE_MS = 2000;

/**
 * Serves one webview: owns the `git log` reader for the current history
 * ("generation") and answers page, details and diff requests.
 */
export class GraphController implements vscode.Disposable {
  private readonly api: GitApi;
  private readonly send: (m: HostToWebview) => void;
  private disposed = false;
  private repo: GitRepository | undefined;
  private reader: LogReader | undefined;
  private generation = 0;
  private options: ViewOptions = DEFAULT_OPTIONS;
  private refs: RefSnapshot | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private repoSubscription: vscode.Disposable | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** Generation whose first page has been served (and timed). */
  private timedGeneration = -1;
  /** Repositories already offered a commit-graph in this session. */
  private readonly suggested = new Set<string>();

  constructor(api: GitApi, post: (m: HostToWebview) => void) {
    this.api = api;
    this.send = post;
    this.disposables.push(
      api.onDidOpenRepository(() => {
        if (!this.repo) void this.start();
      }),
      api.onDidCloseRepository((r) => {
        if (r === this.repo) void this.start();
      }),
    );
  }

  /** Picks the repository of the active editor, else the first one, and starts a new history. */
  async start(options?: ViewOptions): Promise<void> {
    if (options) this.options = options;
    const active = vscode.window.activeTextEditor?.document.uri;
    const repo = (active && this.api.getRepository(active)) ?? this.api.repositories[0];
    if (repo !== this.repo) {
      this.repoSubscription?.dispose();
      this.repo = repo;
      this.repoSubscription = repo?.state.onDidChange(() => {
        this.scheduleRefresh();
      });
    }
    await this.reset();
  }

  /** Replies arrive after awaits; once the panel is gone there is nobody to send them to. */
  private post(m: HostToWebview): void {
    if (!this.disposed) this.send(m);
  }

  async handle(m: WebviewToHost): Promise<void> {
    try {
      switch (m.type) {
        case 'loadMore':
          if (m.generation === this.generation && this.reader) {
            const started = performance.now();
            const page = await this.reader.next(m.count);
            if (this.timedGeneration !== m.generation) {
              this.timedGeneration = m.generation;
              if (performance.now() - started > SLOW_FIRST_PAGE_MS) void this.suggestCommitGraph();
            }
            if (m.generation === this.generation) this.post({ type: 'commits', generation: m.generation, ...page });
          }
          break;
        case 'select':
          if (this.repo && m.generation === this.generation) {
            const details = await readCommitDetails(this.api.git.path, this.repo.rootUri.fsPath, m.hash);
            if (m.generation === this.generation) this.post({ type: 'details', generation: m.generation, details });
          }
          break;
        case 'openFile':
          if (this.repo && m.generation === this.generation) await this.openFile(this.repo, m);
          break;
        case 'setOptions':
          this.options = m.options;
          await this.reset();
          break;
        case 'refresh':
          await this.reset();
          break;
        default:
          break;
      }
    } catch (e) {
      this.post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  private async reset(): Promise<void> {
    this.reader?.dispose();
    this.reader = undefined;
    const generation = ++this.generation;
    const repo = this.repo;
    if (!repo) {
      this.post({ type: 'noRepository' });
      return;
    }
    const cwd = repo.rootUri.fsPath;
    const refs = await readRefs(this.api.git.path, cwd);
    if (generation !== this.generation) return;
    this.refs = refs;
    // Drop filtered refs that no longer exist; with none left, show everything.
    const known = new Set(refs.refs.map((r) => r.name));
    const kept = this.options.refs?.filter((r) => known.has(r)) ?? [];
    this.options = { ...this.options, refs: kept.length > 0 ? kept : null };
    this.reader = new LogReader({
      git: this.api.git.path,
      cwd,
      firstParent: this.options.firstParent,
      refs: this.options.refs ?? undefined,
    });
    this.post({ type: 'reset', generation, repo: { name: basename(cwd), root: cwd }, refs, options: this.options });
  }

  /** Repository state events fire for index and working tree changes too; only ref changes reset the view. */
  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      void this.refreshIfRefsChanged();
    }, REFRESH_DEBOUNCE_MS);
  }

  private async refreshIfRefsChanged(): Promise<void> {
    if (!this.repo) return;
    try {
      const refs = await readRefs(this.api.git.path, this.repo.rootUri.fsPath);
      if (JSON.stringify(refs) !== JSON.stringify(this.refs)) await this.reset();
    } catch (e) {
      this.post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * Opens a changed file as a diff or as its whole content before or after
   * the commit. The git file system fails for a path missing at a ref instead
   * of returning an empty document, so only views with both sides present
   * (see fileViews) are allowed.
   */
  private async openFile(repo: GitRepository, m: Extract<WebviewToHost, { type: 'openFile' }>): Promise<void> {
    const { file, hash, base } = m;
    // Everything here came from the webview: only well-formed commit ids and paths inside the repository.
    if (!isCommitId(hash) || (base !== undefined && !isCommitId(base))) throw new Error('invalid commit id');
    for (const p of [file.path, file.oldPath]) {
      if (p !== undefined && !isRepoPath(p)) throw new Error(`invalid path: ${p}`);
    }
    if (!fileViews(file, base).includes(m.view)) throw new Error(`cannot open ${m.view} of ${file.path}`);
    const uri = (path: string) => vscode.Uri.joinPath(repo.rootUri, ...path.split('/'));
    const short = (h: string) => h.slice(0, 8);
    const name = posix.basename(file.path);
    // Preview tabs: browsing through files replaces one tab instead of piling them up.
    const options: vscode.TextDocumentShowOptions = {
      preview: true,
      ...(m.beside ? { viewColumn: vscode.ViewColumn.Beside } : {}),
    };
    // fileViews guarantees a base for 'diff' and 'before'.
    switch (m.view) {
      case 'after':
        await vscode.commands.executeCommand(
          'vscode.open',
          this.api.toGitUri(uri(file.path), hash),
          options,
          `${name} (${short(hash)})`,
        );
        break;
      case 'before': {
        const path = file.oldPath ?? file.path;
        const title = `${posix.basename(path)} (before ${short(hash)}, at ${short(base!)})`;
        await vscode.commands.executeCommand('vscode.open', this.api.toGitUri(uri(path), base!), options, title);
        break;
      }
      case 'diff': {
        const label = file.oldPath ? `${posix.basename(file.oldPath)} → ${name}` : name;
        await vscode.commands.executeCommand(
          'vscode.diff',
          this.api.toGitUri(uri(file.oldPath ?? file.path), base!),
          this.api.toGitUri(uri(file.path), hash),
          `${label} (${short(base!)} ↔ ${short(hash)})`,
          options,
        );
        break;
      }
    }
  }

  /** Writes a commit-graph with progress, then reloads the history. */
  async writeCommitGraph(): Promise<void> {
    const repo = this.repo;
    if (!repo) return;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Strata: writing commit-graph for ${basename(repo.rootUri.fsPath)}…`,
      },
      () => writeCommitGraph(this.api.git.path, repo.rootUri.fsPath),
    );
    await this.reset();
  }

  private async suggestCommitGraph(): Promise<void> {
    const repo = this.repo;
    if (!repo || this.suggested.has(repo.rootUri.fsPath)) return;
    const config = vscode.workspace.getConfiguration('strata');
    if (!config.get<boolean>('suggestCommitGraph', true)) return;
    if (await hasCommitGraph(this.api.git.path, repo.rootUri.fsPath)) return;
    this.suggested.add(repo.rootUri.fsPath);
    const write = 'Write commit-graph';
    const never = "Don't ask again";
    const choice = await vscode.window.showInformationMessage(
      `History of ${basename(repo.rootUri.fsPath)} loads slowly because the repository has no commit-graph. ` +
        'Writing one (git commit-graph write --reachable) makes the graph open in a fraction of the time.',
      write,
      'Not now',
      never,
    );
    if (choice === write) await this.writeCommitGraph();
    else if (choice === never) await config.update('suggestCommitGraph', false, vscode.ConfigurationTarget.Global);
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.refreshTimer);
    this.reader?.dispose();
    this.repoSubscription?.dispose();
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}

/** A repository-relative path as git prints it: '/'-separated, no empty, '.' or '..' segments. */
function isRepoPath(p: string): boolean {
  return (
    p.length > 0 &&
    !p.includes('\0') &&
    !p.includes('\\') &&
    p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
  );
}
