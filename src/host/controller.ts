import * as vscode from 'vscode';
import type { Ref, RefSnapshot } from '../core/refs.ts';
import type { RepoKey } from '../core/repos.ts';
import type { StashEntry } from '../core/stash.ts';
import type { FileChange, FileView } from '../core/details.ts';
import { DEFAULT_OPTIONS, type HostToWebview, type ViewOptions, type WebviewToHost } from '../shared/protocol.ts';
import { setContext } from './context.ts';
import type { FlowEnv, FlowHost, FlowSettings, Leftovers, Undo } from './flow.ts';
import { repoKey, type GitApi } from './git-api.ts';
import { RepoSession } from './session.ts';

/**
 * Serves one webview: picks the repository it shows and keeps a RepoSession for it. Flows change
 * the repository through it.
 */
export class GraphController implements vscode.Disposable, FlowHost {
  private readonly api: GitApi;
  private readonly send: (m: HostToWebview) => void;
  private readonly env: FlowEnv;
  private disposed = false;
  private session: RepoSession | undefined;
  /** Options for the next session when there is none to take them from. */
  private options: ViewOptions = DEFAULT_OPTIONS;
  /** Repositories already offered a commit-graph in this session. */
  private readonly suggested = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(api: GitApi, post: (m: HostToWebview) => void, env: FlowEnv) {
    this.api = api;
    this.send = post;
    this.env = env;
    this.disposables.push(
      api.onDidOpenRepository(() => {
        if (!this.session) void this.start();
      }),
      api.onDidCloseRepository((r) => {
        if (repoKey(r) === this.session?.key) void this.start();
      }),
    );
  }

  /** Picks the repository of the active editor, else the first one, and starts a new history. */
  async start(options?: ViewOptions): Promise<void> {
    if (this.disposed) return;
    if (options) this.options = options;
    else if (this.session) this.options = this.session.options;
    const active = vscode.window.activeTextEditor?.document.uri;
    const repo = (active && this.api.getRepository(active)) ?? this.api.repositories[0];
    const key: RepoKey | undefined = repo && repoKey(repo);
    if (key !== this.session?.key) {
      const generation = this.session?.generation ?? 0;
      this.session?.dispose();
      this.session =
        repo &&
        new RepoSession(repo, {
          api: this.api,
          env: this.env,
          post: (m) => {
            this.post(m);
          },
          generation,
          options: this.options,
          suggested: this.suggested,
        });
    } else if (this.session) this.session.options = this.options;
    if (this.session) await this.session.reset();
    else {
      this.post({ type: 'noRepository' });
      await Promise.all([setContext('strata.operation', ''), setContext('strata.head', '')]);
    }
  }

  private post(m: HostToWebview): void {
    if (!this.disposed) this.send(m);
  }

  async handle(m: WebviewToHost): Promise<void> {
    if (this.session) await this.session.handle(m);
    else if (m.type === 'refresh') await this.start();
  }

  private require(): RepoSession {
    if (!this.session) throw new Error('no repository');
    return this.session;
  }

  hideBadge(ref: Ref): Promise<void> {
    return this.require().hideBadge(ref);
  }

  readonly leftovers: Leftovers = {
    pushed: (hash, head) => this.require().leftovers.pushed(hash, head),
    held: (operation) => this.require().leftovers.held(operation),
    markRestoreConflicted: (hash) => this.require().leftovers.markRestoreConflicted(hash),
    keep: (hash) => this.require().leftovers.keep(hash),
  };

  reveal(hash: string): void {
    this.session?.reveal(hash);
  }

  openFileFromMenu(
    hash: string,
    base: string | undefined,
    file: FileChange,
    view: FileView | 'primary',
    beside: boolean,
  ): Promise<void> {
    return this.require().openFileFromMenu(hash, base, file, view, beside);
  }

  absolutePath(path: string): string {
    return this.require().absolutePath(path);
  }

  shortHash(hash: string): Promise<string> {
    return this.require().shortHash(hash);
  }

  copyCommitPatch(hash: string): Promise<void> {
    return this.require().copyCommitPatch(hash);
  }

  copyStashPatch(hash: string): Promise<void> {
    return this.require().copyStashPatch(hash);
  }

  showStashes(): void {
    this.session?.showStashes();
  }

  copyFilePatch(hash: string, base: string | undefined, file: FileChange): Promise<void> {
    return this.require().copyFilePatch(hash, base, file);
  }

  get git(): string {
    return this.api.git.path;
  }

  get cwd(): string {
    return this.require().cwd;
  }

  get ui() {
    return this.env.ui;
  }

  get runner() {
    return this.env.runner;
  }

  get refs(): RefSnapshot {
    if (!this.session) throw new Error('the commit graph has not loaded a repository');
    return this.session.refs;
  }

  get stashes(): readonly StashEntry[] {
    return this.session?.stashes ?? [];
  }

  get lastUndo(): Undo | undefined {
    return this.session?.lastUndo;
  }

  settings(): FlowSettings {
    return this.require().settings();
  }

  refresh(focus?: string, notified = false): Promise<void> {
    return this.session?.refresh(focus, notified) ?? this.start();
  }

  done(message: string): void {
    this.session?.done(message);
  }

  setUndo(undo: Undo | undefined): void {
    this.session?.setUndo(undo);
  }

  busy(label: string | undefined): void {
    this.session?.busy(label);
  }

  /** Writes a commit-graph for the shown repository and reloads. */
  writeCommitGraph(): Promise<void> {
    return this.session?.writeCommitGraph() ?? Promise.resolve();
  }

  dispose(): void {
    this.session?.dispose();
    this.disposed = true;
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}
