import { basename, posix } from 'node:path';
import * as vscode from 'vscode';
import type { RefSnapshot } from '../core/refs.ts';
import { hasCommitGraph, updateCommitGraph, writeCommitGraph } from '../git/commit-graph.ts';
import { fileViews, type FileChange, type FileView } from '../core/details.ts';
import { patchStats } from '../core/patch.ts';
import { isCommitId, readCommitDetails } from '../git/details.ts';
import { LogReader } from '../git/log-reader.ts';
import { readCommitPatch, readFilePatch } from '../git/patch.ts';
import { readRefs } from '../git/refs.ts';
import { runGit } from '../git/run.ts';
import { DEFAULT_OPTIONS, type HostToWebview, type ViewOptions, type WebviewToHost } from '../shared/protocol.ts';
import type { GitApi, GitRepository } from './git-api.ts';

const REFRESH_DEBOUNCE_MS = 400;
/** A first page slower than this suggests writing a commit-graph (git's topological walk reads all history without one). */
const SLOW_FIRST_PAGE_MS = 2000;
/** The commit-graph is updated this long after the history changed, so it does not compete with the first page. */
const GRAPH_UPDATE_DELAY_MS = 3000;
/** Patches larger than this are copied only after asking: pasting them can freeze an editor. */
const LARGE_PATCH_BYTES = 4 << 20;

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
  /** The file last opened from the graph and the URIs of its tab; `shown` is what the graph was told. */
  private opened: { path: string; uris: Set<string> } | undefined;
  private shownFile: string | undefined;
  /** Generation whose first page has been served (and timed). */
  private timedGeneration = -1;
  /** Repositories already offered a commit-graph in this session. */
  private readonly suggested = new Set<string>();
  private graphTimer: ReturnType<typeof setTimeout> | undefined;
  /** An update is running; `graphAgain` asks for another one when it ends. */
  private graphUpdating = false;
  private graphAgain = false;

  constructor(api: GitApi, post: (m: HostToWebview) => void) {
    this.api = api;
    this.send = post;
    this.disposables.push(
      vscode.window.tabGroups.onDidChangeTabs(() => {
        this.syncShownFile();
      }),
      vscode.window.tabGroups.onDidChangeTabGroups(() => {
        this.syncShownFile();
      }),
      api.onDidOpenRepository(() => {
        if (!this.repo) void this.start();
      }),
      api.onDidCloseRepository((r) => {
        if (r === this.repo) void this.start();
      }),
    );
  }

  /** Tells the graph which of its files has a tab on screen (the active tab of any group). */
  private syncShownFile(): void {
    const opened = this.opened;
    const onScreen = vscode.window.tabGroups.all.some((g) => {
      const input = g.activeTab?.input;
      const uris =
        input instanceof vscode.TabInputTextDiff
          ? [input.original, input.modified]
          : input instanceof vscode.TabInputText
            ? [input.uri]
            : [];
      return !!opened && uris.some((u) => opened.uris.has(u.toString()));
    });
    const shown = onScreen ? opened?.path : undefined;
    if (shown === this.shownFile) return;
    this.shownFile = shown;
    this.post({ type: 'activeFile', path: shown });
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
    this.scheduleGraphUpdate();
  }

  /** With strata.keepCommitGraphUpdated, adds new commits to the repository's commit-graph after a change. */
  private scheduleGraphUpdate(): void {
    if (!vscode.workspace.getConfiguration('strata').get<boolean>('keepCommitGraphUpdated', false)) return;
    clearTimeout(this.graphTimer);
    this.graphTimer = setTimeout(() => {
      void this.updateGraph();
    }, GRAPH_UPDATE_DELAY_MS);
  }

  private async updateGraph(): Promise<void> {
    const repo = this.repo;
    if (!repo || this.disposed) return;
    if (this.graphUpdating) {
      this.graphAgain = true;
      return;
    }
    this.graphUpdating = true;
    try {
      await updateCommitGraph(this.api.git.path, repo.rootUri.fsPath);
    } catch {
      // Another git process holds the commit-graph lock, or git cannot write one here (e.g. a
      // shallow clone). Nothing is lost: the next change tries again.
    } finally {
      this.graphUpdating = false;
      if (this.graphAgain) {
        this.graphAgain = false;
        this.scheduleGraphUpdate();
      }
    }
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
    const git = (path: string, ref: string) => {
      const u = this.api.toGitUri(uri(path), ref);
      opened.add(u.toString());
      return u;
    };
    // Remembered so the graph can mark the file while this tab is on screen.
    const opened = new Set<string>();
    this.opened = { path: file.path, uris: opened };
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
        await vscode.commands.executeCommand('vscode.open', git(file.path, hash), options, `${name} (${short(hash)})`);
        break;
      case 'before': {
        const path = file.oldPath ?? file.path;
        const title = `${posix.basename(path)} (before ${short(hash)}, at ${short(base!)})`;
        await vscode.commands.executeCommand('vscode.open', git(path, base!), options, title);
        break;
      }
      case 'diff': {
        const label = file.oldPath ? `${posix.basename(file.oldPath)} → ${name}` : name;
        await vscode.commands.executeCommand(
          'vscode.diff',
          git(file.oldPath ?? file.path, base!),
          git(file.path, hash),
          `${label} (${short(base!)} ↔ ${short(hash)})`,
          options,
        );
        break;
      }
    }
    this.syncShownFile();
  }

  /** Opens a changed file from a context menu; `primary` is what clicking the file opens. */
  async openFileFromMenu(
    hash: string,
    base: string | undefined,
    file: FileChange,
    view: FileView | 'primary',
    beside: boolean,
  ): Promise<void> {
    if (!this.repo) throw new Error('no repository');
    const resolved = view === 'primary' ? fileViews(file, base)[0]! : view;
    await this.openFile(this.repo, {
      type: 'openFile',
      generation: this.generation,
      hash,
      base,
      file,
      view: resolved,
      beside,
    });
  }

  /** Absolute file system path of a repository-relative path. */
  absolutePath(path: string): string {
    if (!this.repo) throw new Error('no repository');
    return vscode.Uri.joinPath(this.repo.rootUri, ...path.split('/')).fsPath;
  }

  /** Shortest unambiguous abbreviation of a commit id, as git prints it. */
  async shortHash(hash: string): Promise<string> {
    if (!this.repo) throw new Error('no repository');
    return (await runGit(this.api.git.path, this.repo.rootUri.fsPath, ['rev-parse', '--short', hash])).trim();
  }

  /** Copies the commit as an email patch (a merge against its first parent). */
  async copyCommitPatch(hash: string): Promise<void> {
    const repo = this.requireRepo();
    const cwd = repo.rootUri.fsPath;
    const [patch, short, merge] = await Promise.all([
      readPatch(readCommitPatch(this.api.git.path, cwd, hash)),
      this.shortHash(hash),
      runGit(this.api.git.path, cwd, ['rev-parse', '--verify', '--quiet', `${hash}^2`]).then(
        () => true,
        () => false,
      ),
    ]);
    await this.copyPatch(patch, merge ? `merge ${short} (against its first parent)` : short, `${short}.patch`);
  }

  /** Copies the change to one file of a commit as a plain diff. */
  async copyFilePatch(hash: string, base: string | undefined, file: FileChange): Promise<void> {
    const repo = this.requireRepo();
    const [patch, short] = await Promise.all([
      readPatch(readFilePatch(this.api.git.path, repo.rootUri.fsPath, hash, base, file)),
      this.shortHash(hash),
    ]);
    const name = posix.basename(file.path);
    await this.copyPatch(patch, `${file.path} in ${short}`, `${short}-${name}.patch`);
  }

  private async copyPatch(patch: string, label: string, fileName: string): Promise<void> {
    const size = Buffer.byteLength(patch);
    if (size > LARGE_PATCH_BYTES) {
      const copy = 'Copy Anyway';
      const save = 'Save to File…';
      const choice = await vscode.window.showWarningMessage(
        `The patch of ${label} is ${(size / (1 << 20)).toFixed(1)} MB.`,
        { modal: true, detail: 'Pasting a patch this large can make an editor or chat unresponsive.' },
        copy,
        save,
      );
      if (choice === save) {
        const target = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.joinPath(this.requireRepo().rootUri, fileName),
          filters: { Patch: ['patch', 'diff'] },
        });
        if (!target) return;
        await vscode.workspace.fs.writeFile(target, Buffer.from(patch));
        this.notify(`Saved patch of ${label} to ${target.fsPath}`);
        return;
      }
      if (choice !== copy) return;
    }
    await vscode.env.clipboard.writeText(patch);
    const s = patchStats(patch);
    this.notify(
      `Copied patch of ${label}: ${s.files} ${s.files === 1 ? 'file' : 'files'}, +${s.insertions} −${s.deletions}`,
    );
  }

  /** Reports the result of an action in the status bar and to screen readers in the graph. */
  private notify(message: string): void {
    vscode.window.setStatusBarMessage(`$(check) ${message}`, 5000);
    this.post({ type: 'notice', message });
  }

  private requireRepo(): GitRepository {
    if (!this.repo) throw new Error('no repository');
    return this.repo;
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
    const keep = 'Write and keep updated';
    const write = 'Write once';
    const never = "Don't ask again";
    const choice = await vscode.window.showInformationMessage(
      `History of ${basename(repo.rootUri.fsPath)} loads slowly because the repository has no commit-graph. ` +
        'Writing one (git commit-graph write --reachable) makes the graph open in a fraction of the time. ' +
        'Kept updated, it also covers new commits as they come in.',
      keep,
      write,
      'Not now',
      never,
    );
    if (choice === keep) await config.update('keepCommitGraphUpdated', true, vscode.ConfigurationTarget.Global);
    if (choice === keep || choice === write) await this.writeCommitGraph();
    else if (choice === never) await config.update('suggestCommitGraph', false, vscode.ConfigurationTarget.Global);
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.refreshTimer);
    clearTimeout(this.graphTimer);
    this.reader?.dispose();
    this.repoSubscription?.dispose();
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}

/** A repository-relative path as git prints it: '/'-separated, no empty, '.' or '..' segments. */
export function isRepoPath(p: string): boolean {
  return (
    p.length > 0 &&
    !p.includes('\0') &&
    !p.includes('\\') &&
    p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
  );
}

/** runGit's output cap is the patch size limit; its error does not say so. */
function readPatch(read: Promise<string>): Promise<string> {
  return read.catch((e: unknown) => {
    if (e instanceof Error && /maxBuffer/i.test(e.message))
      throw new Error('The patch is larger than 64 MB and cannot be copied.');
    throw e;
  });
}
