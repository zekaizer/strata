import { basename } from 'node:path';
import * as vscode from 'vscode';
import { parseRepoKey, pickRepo, type RepoKey, type RepoPreference } from '../core/repos.ts';
import { DEFAULT_OPTIONS, type HostToWebview, type ViewOptions, type WebviewToHost } from '../shared/protocol.ts';
import { setContext } from './context.ts';
import type { FlowEnv } from './flow.ts';
import type { GitRepository } from './git-api.ts';
import type { RepoList } from './repositories.ts';
import { RepoSession } from './session.ts';

/** What the webview saved in a previous session of the panel (see the `ready` message). */
export type SavedView = Pick<Extract<WebviewToHost, { type: 'ready' }>, 'last' | 'views' | 'options'>;

/** Serves one webview: picks the repository it shows and keeps a RepoSession for it. */
export class GraphController implements vscode.Disposable {
  private readonly repos: RepoList;
  private readonly send: (m: HostToWebview) => void;
  private readonly env: FlowEnv;
  private disposed = false;
  private session: RepoSession | undefined;
  /** The repository the panel showed last, until it is shown or the user chooses another. */
  private restored: string | undefined;
  /** View options of each repository the panel showed, by root, as the webview saved them. */
  private readonly views = new Map<string, ViewOptions>();
  /** Options saved before they were kept per repository: the first repository shown takes them. */
  private unkeyed: ViewOptions | undefined;
  /** Repositories already offered a commit-graph in this session. */
  private readonly suggested = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly setTitle: (title: string) => void;

  /** `title` names the panel. */
  constructor(repos: RepoList, post: (m: HostToWebview) => void, env: FlowEnv, title: (title: string) => void) {
    this.repos = repos;
    this.send = post;
    this.env = env;
    this.setTitle = title;
    this.disposables.push(
      repos.onDidChange(() => {
        void this.follow();
      }),
    );
  }

  /** The session of the repository shown. */
  get shown(): RepoSession | undefined {
    return this.session;
  }

  /**
   * The webview (re)started: shows `chosen` (the user's choice) when given, else the repository
   * it showed last when open, else the best one open.
   */
  start(saved?: SavedView, chosen?: RepoKey): Promise<void> {
    if (saved) {
      this.restored = saved.last;
      this.views.clear();
      for (const [root, options] of Object.entries(saved.views)) this.views.set(root, options);
      this.unkeyed = saved.options;
    }
    if (chosen !== undefined) this.restored = undefined;
    return this.pick({ chosen }, saved !== undefined);
  }

  /** Shows the repository the user chose, when it is open. */
  choose(key: RepoKey): Promise<void> {
    this.restored = undefined;
    return this.pick({ chosen: key });
  }

  /** A repository opened or closed: the restored one may be open now, or the shown one gone. */
  private async follow(): Promise<void> {
    const before = this.session?.key;
    await this.pick({});
    const now = this.session?.key;
    if (before === undefined || now === before || this.repos.get(before)) return;
    const message = `${basename(before)} was closed${now === undefined ? '' : `; showing ${basename(now)}`}`;
    vscode.window.setStatusBarMessage(message, 5000);
    this.post({ type: 'notice', message });
  }

  private pick(p: Pick<RepoPreference, 'chosen'>, reloaded = false): Promise<void> {
    const key = pickRepo(this.repos.keys(), {
      ...p,
      restored: this.restored,
      shown: this.session?.key,
      active: this.repos.active(),
    });
    if (key === this.restored) this.restored = undefined;
    return this.show(key, reloaded);
  }

  /** Shows `key` (none: says there is no repository), keeping its session when it is shown already. */
  private async show(key: RepoKey | undefined, reloaded: boolean): Promise<void> {
    if (this.disposed) return;
    const repo = key && this.repos.get(key);
    if (!repo) {
      this.replace(undefined);
      this.listed();
      this.post({ type: 'noRepository' });
      await Promise.all([
        setContext('strata.operation', ''),
        setContext('strata.head', ''),
        setContext('strata.canUndo', false),
      ]);
      return;
    }
    if (key === this.session?.key && !reloaded) {
      this.listed();
      return;
    }
    if (key !== this.session?.key) this.replace(this.newSession(key, repo));
    else this.session.options = this.optionsOf(key);
    this.listed();
    await this.session!.reset();
  }

  /** Tells the graph which repositories are open, and names the shown one in the title when there are several. */
  private listed(): void {
    const repos = this.repos.items();
    this.post({ type: 'repositories', repos });
    const shown = this.session && repos.length > 1 ? ` (${basename(this.session.key)})` : '';
    this.setTitle(`Commit Graph${shown}`);
  }

  private replace(session: RepoSession | undefined): void {
    const old = this.session;
    if (old) this.views.set(old.key, old.options);
    old?.dispose();
    this.session = session;
  }

  private optionsOf(key: RepoKey): ViewOptions {
    // States saved before an option existed lack it.
    return { ...DEFAULT_OPTIONS, ...(this.views.get(key) ?? this.unkeyed) };
  }

  private newSession(key: RepoKey, repo: GitRepository): RepoSession {
    const session = new RepoSession(repo, {
      api: this.repos.api,
      env: this.env,
      post: (m) => {
        this.post(m);
      },
      generation: this.session?.generation ?? 0,
      options: this.optionsOf(key),
      suggested: this.suggested,
      busy: (label) => {
        this.post({ type: 'busy', label });
      },
      reveal: (key, hash) => {
        void this.reveal(key, hash);
      },
    });
    this.unkeyed = undefined;
    return session;
  }

  private async reveal(key: RepoKey, hash: string): Promise<void> {
    if (this.session?.key !== key) await this.choose(key);
    if (this.session?.key === key) this.post({ type: 'reveal', hash });
  }

  private post(m: HostToWebview): void {
    if (!this.disposed) this.send(m);
  }

  async handle(m: WebviewToHost): Promise<void> {
    if (m.type === 'listRepositories') this.listed();
    else if (m.type === 'switchRepository') {
      // A root the webview names must be an open repository's.
      const key = parseRepoKey(m.root, this.repos.keys());
      if (key !== undefined) await this.choose(key);
    } else if (this.session) await this.session.handle(m);
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
