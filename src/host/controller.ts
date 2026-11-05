import * as vscode from 'vscode';
import type { RepoKey } from '../core/repos.ts';
import { DEFAULT_OPTIONS, type HostToWebview, type ViewOptions, type WebviewToHost } from '../shared/protocol.ts';
import { setContext } from './context.ts';
import type { FlowEnv } from './flow.ts';
import { repoKey, type GitApi, type GitRepository } from './git-api.ts';
import { RepoSession } from './session.ts';

/** Serves one webview: picks the repository it shows and keeps a RepoSession for it. */
export class GraphController implements vscode.Disposable {
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

  /** The session of the repository shown. */
  get shown(): RepoSession | undefined {
    return this.session;
  }

  /** Picks the repository of the active editor, else the first one, and starts a new history. */
  start(options?: ViewOptions): Promise<void> {
    const active = vscode.window.activeTextEditor?.document.uri;
    return this.show((active && this.api.getRepository(active)) ?? this.api.repositories[0], options);
  }

  /** Shows `repo` (none: says there is no repository), keeping its session when it is shown already. */
  private async show(repo: GitRepository | undefined, options?: ViewOptions): Promise<void> {
    if (this.disposed) return;
    this.options = options ?? this.session?.options ?? this.options;
    const key = repo && repoKey(repo);
    if (key !== this.session?.key) {
      const generation = this.session?.generation ?? 0;
      this.session?.dispose();
      this.session = repo && this.newSession(repo, generation);
    } else if (this.session) this.session.options = this.options;
    if (this.session) await this.session.reset();
    else {
      this.post({ type: 'noRepository' });
      await Promise.all([
        setContext('strata.operation', ''),
        setContext('strata.head', ''),
        setContext('strata.canUndo', false),
      ]);
    }
  }

  private newSession(repo: GitRepository, generation: number): RepoSession {
    return new RepoSession(repo, {
      api: this.api,
      env: this.env,
      post: (m) => {
        this.post(m);
      },
      generation,
      options: this.options,
      suggested: this.suggested,
      busy: (label) => {
        this.post({ type: 'busy', label });
      },
      reveal: (key, hash) => {
        void this.reveal(key, hash);
      },
    });
  }

  private async reveal(key: RepoKey, hash: string): Promise<void> {
    if (this.session?.key !== key) {
      const repo = this.api.repositories.find((r) => repoKey(r) === key);
      if (!repo) return;
      await this.show(repo);
    }
    this.post({ type: 'reveal', hash });
  }

  private post(m: HostToWebview): void {
    if (!this.disposed) this.send(m);
  }

  async handle(m: WebviewToHost): Promise<void> {
    if (this.session) await this.session.handle(m);
    else if (m.type === 'refresh') await this.start();
  }

  dispose(): void {
    // A closed graph's Undo toast can still be clicked: it says Undo is gone.
    if (this.session) this.env.undos.delete(this.session.key);
    void setContext('strata.canUndo', false);
    this.session?.dispose();
    this.disposed = true;
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}
