import { basename, posix } from 'node:path';
import * as vscode from 'vscode';
import type { RefSnapshot } from '../core/refs.ts';
import { readCommitDetails } from '../git/details.ts';
import { LogReader } from '../git/log-reader.ts';
import { readRefs } from '../git/refs.ts';
import { DEFAULT_OPTIONS, type HostToWebview, type ViewOptions, type WebviewToHost } from '../shared/protocol.ts';
import type { GitApi, GitRepository } from './git-api.ts';

const REFRESH_DEBOUNCE_MS = 400;

/**
 * Serves one webview: owns the `git log` reader for the current history
 * ("generation") and answers page, details and diff requests.
 */
export class GraphController implements vscode.Disposable {
  private readonly api: GitApi;
  private readonly post: (m: HostToWebview) => void;
  private repo: GitRepository | undefined;
  private reader: LogReader | undefined;
  private generation = 0;
  private options: ViewOptions = DEFAULT_OPTIONS;
  private refs: RefSnapshot | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private repoSubscription: vscode.Disposable | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(api: GitApi, post: (m: HostToWebview) => void) {
    this.api = api;
    this.post = post;
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

  async handle(m: WebviewToHost): Promise<void> {
    try {
      switch (m.type) {
        case 'loadMore':
          if (m.generation === this.generation && this.reader) {
            const page = await this.reader.next(m.count);
            if (m.generation === this.generation) this.post({ type: 'commits', generation: m.generation, ...page });
          }
          break;
        case 'select':
          if (this.repo && m.generation === this.generation) {
            const details = await readCommitDetails(this.api.git.path, this.repo.rootUri.fsPath, m.hash);
            if (m.generation === this.generation) this.post({ type: 'details', generation: m.generation, details });
          }
          break;
        case 'openDiff':
          if (this.repo) await this.openDiff(this.repo, m);
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
   * Modified and renamed files open in the diff editor. The git file system
   * fails for a path missing at a ref instead of returning an empty document,
   * so added and deleted files open the side that exists.
   */
  private async openDiff(repo: GitRepository, m: Extract<WebviewToHost, { type: 'openDiff' }>): Promise<void> {
    const { file, hash, base } = m;
    const uri = (path: string) => vscode.Uri.joinPath(repo.rootUri, ...path.split('/'));
    const short = (h: string) => h.slice(0, 8);
    // Preview tabs: browsing through files replaces one tab instead of piling them up.
    const options: vscode.TextDocumentShowOptions = {
      preview: true,
      ...(m.beside ? { viewColumn: vscode.ViewColumn.Beside } : {}),
    };
    if (file.status === 'A' || base === undefined) {
      await vscode.commands.executeCommand(
        'vscode.open',
        this.api.toGitUri(uri(file.path), hash),
        options,
        `${posix.basename(file.path)} (${short(hash)})`,
      );
      return;
    }
    if (file.status === 'D') {
      await vscode.commands.executeCommand(
        'vscode.open',
        this.api.toGitUri(uri(file.path), base),
        options,
        `${posix.basename(file.path)} (deleted, ${short(base)})`,
      );
      return;
    }
    const left = this.api.toGitUri(uri(file.oldPath ?? file.path), base);
    const right = this.api.toGitUri(uri(file.path), hash);
    const label = file.oldPath
      ? `${posix.basename(file.oldPath)} → ${posix.basename(file.path)}`
      : posix.basename(file.path);
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      right,
      `${label} (${short(base)} ↔ ${short(hash)})`,
      options,
    );
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    this.reader?.dispose();
    this.repoSubscription?.dispose();
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}
