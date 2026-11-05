import { basename, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import { sortRepos, type RepoKey, type RepoSortOrder } from '../core/repos.ts';
import type { RepoItem } from '../shared/protocol.ts';
import { getGitApi, repoKey, type GitApi, type GitRepository } from './git-api.ts';

const SORT_ORDERS: readonly string[] = ['discoveryTime', 'name', 'path'] satisfies RepoSortOrder[];

/**
 * The repositories VS Code has open, in the order its Source Control view lists them, kept live
 * as they open and close.
 */
export class RepoList implements vscode.Disposable {
  readonly api: GitApi;
  /** When each open repository was first seen, as a sequence number. */
  private readonly seen = new Map<RepoKey, number>();
  private next = 0;
  private readonly changed = new vscode.EventEmitter<void>();
  /** A repository opened or closed. */
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[];

  constructor(api: GitApi) {
    this.api = api;
    for (const r of api.repositories) this.note(r);
    this.disposables = [
      this.changed,
      api.onDidOpenRepository((r) => {
        this.note(r);
        this.changed.fire();
      }),
      api.onDidCloseRepository((r) => {
        this.seen.delete(repoKey(r));
        this.changed.fire();
      }),
    ];
  }

  private note(r: GitRepository): void {
    const key = repoKey(r);
    if (!this.seen.has(key)) this.seen.set(key, this.next++);
  }

  /** The open repositories, ordered as scm.repositories.sortOrder says. */
  list(): { key: RepoKey; name: string; repo: GitRepository }[] {
    const setting = vscode.workspace.getConfiguration('scm').get<string>('repositories.sortOrder', 'discoveryTime');
    const order = SORT_ORDERS.includes(setting) ? (setting as RepoSortOrder) : 'discoveryTime';
    const open = this.api.repositories.map((repo) => ({
      key: repoKey(repo),
      name: basename(repo.rootUri.fsPath),
      repo,
    }));
    return sortRepos(open, order, this.seen);
  }

  /** The open repositories as the repository switcher lists them. */
  items(): RepoItem[] {
    return this.list().map(({ key, name, repo }) => {
      const { HEAD } = repo.state;
      return { root: key, name, path: placeOf(repo.rootUri), head: HEAD?.name ?? HEAD?.commit?.slice(0, 8) };
    });
  }

  keys(): RepoKey[] {
    return this.list().map((r) => r.key);
  }

  get(key: RepoKey): GitRepository | undefined {
    return this.api.repositories.find((r) => repoKey(r) === key);
  }

  /** The repository holding `uri`, the innermost one when repositories nest. */
  keyOf(uri: vscode.Uri): RepoKey | undefined {
    const repo = this.api.getRepository(uri);
    return repo ? repoKey(repo) : undefined;
  }

  /** The repository of the active text editor. */
  active(): RepoKey | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return uri && this.keyOf(uri);
  }

  dispose(): void {
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}

/** Where a repository is: relative to its workspace folder (named when there are several), else its full path. */
function placeOf(root: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(root);
  if (!folder) return root.fsPath;
  const inside = relative(folder.uri.fsPath, root.fsPath).split(sep).join('/');
  if (inside === '') return folder.name;
  return (vscode.workspace.workspaceFolders?.length ?? 0) > 1 ? `${folder.name}/${inside}` : inside;
}

let shared: Promise<RepoList> | undefined;

/** The window's one RepoList, once the git extension has found its repositories. */
export function repoList(): Promise<RepoList> {
  shared ??= getGitApi().then((api) => new RepoList(api));
  // Retried on the next call: the git extension may be enabled later.
  shared.catch(() => {
    shared = undefined;
  });
  return shared;
}

export function disposeRepoList(): void {
  void shared?.then((l) => {
    l.dispose();
  });
  shared = undefined;
}
