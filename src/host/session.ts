import { watch, type FSWatcher } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, posix, resolve } from 'node:path';
import * as vscode from 'vscode';
import { addRule, hiddenRefs, parseRules, type BadgeRule } from '../core/badge-rules.ts';
import { heldBy, leftoverOf, settleMarks, type AutostashSetting, type StashMark } from '../core/autostash.ts';
import type { Ref, RefSnapshot } from '../core/refs.ts';
import {
  changesSummary,
  listChanges,
  parseStatus,
  type ChangedPath,
  type ChangesSummary,
  type Leftover,
  type OperationState,
} from '../core/repo-state.ts';
import type { StashEntry } from '../core/stash.ts';
import { hasChangedPaths, hasCommitGraph, updateCommitGraph, writeCommitGraph } from '../git/commit-graph.ts';
import { changingCommits, isPartialClone, isTracked, readPathOrigin } from '../git/path-history.ts';
import { fileViews, type FileChange, type FileView } from '../core/details.ts';
import { patchStats } from '../core/patch.ts';
import { COMMIT_GRAPH_OFFER, DONE } from '../core/wording.ts';
import { inFilter, isRepoPath, parsePathFilter, samePathFilter, type PathFilter } from '../core/path-filter.ts';
import { isCommitId, readCommitDetails } from '../git/details.ts';
import { LogReader, type LogOptions } from '../git/log-reader.ts';
import { findCommits, findExact, locateCommit } from '../git/find.ts';
import type { FindHit, FindQuery } from '../core/find.ts';
import { readCommitPatch, readFilePatch, readStashPatch } from '../git/patch.ts';
import { readRefs } from '../git/refs.ts';
import { readStashDetails, readStashes, stashCache } from '../git/stash.ts';
import { readWhere } from '../git/where.ts';
import { pickStash } from './stash-pick.ts';
import { runGit } from '../git/run.ts';
import { readGraphStatus, readOperationState } from '../git/state.ts';
import type { HostToWebview, MessageDraft, ViewOptions, WebviewToHost, WorkingDetails } from '../shared/protocol.ts';
import { resolveConflicts } from './flows/changes.ts';
import { setContext, type ContextKey } from './context.ts';
import { readUnmerged, readUpstream, refsReach } from '../git/facts.ts';
import type { FlowEnv, FlowHost, FlowSettings, Leftovers, Undo } from './flow.ts';
import type { RepoKey } from '../core/repos.ts';
import { repoKey, type GitApi, type GitRepository } from './git-api.ts';

const REFRESH_DEBOUNCE_MS = 400;
/** A first page slower than this suggests writing a commit-graph (git's topological walk reads all history without one). */
const SLOW_FIRST_PAGE_MS = 2000;
/** The commit-graph is updated this long after the history changed, so it does not compete with the first page. */
const GRAPH_UPDATE_DELAY_MS = 3000;
/** A path history not read to its end after this long suggests changed-path filters, which speed it up several times. */
const SLOW_PATH_MS = 2000;
/** A path history's page holds what has arrived after this long: a rare path's commits are spread over all of history. */
const PATH_FLUSH_MS = 150;
/** Patches larger than this are copied only after asking: pasting them can freeze an editor. */
const LARGE_PATCH_BYTES = 4 << 20;
/** Each git query behind the ref card's On, First in and After lines is stopped after this; its line is left out. */
export const WHERE_BUDGET_MS = 300;

/** Commits a search hands out at most; the find widget then says "10,000+". */
export const FIND_CAP = 10_000;
/**
 * Counting untracked files for the uncommitted changes row stops after this; the row then leaves
 * them out for the rest of the session (a huge folder git does not ignore).
 */
export const UNTRACKED_BUDGET_MS = 1000;
/** The unfolded uncommitted changes row lists at most this many paths per group. */
const CHANGES_LISTED = 2000;

/** workspaceState key of Strata's stash marks, by the git dir of the worktree they belong to. */
const STASH_MARKS = 'strata.stashMarks';

const AUTOSTASH: readonly string[] = ['gitConfig', 'always', 'never'] satisfies AutostashSetting[];

/** What a session needs from the graph it serves. */
export interface SessionDeps {
  readonly api: GitApi;
  readonly env: FlowEnv;
  readonly post: (m: HostToWebview) => void;
  /** Generations continue from the previous session's, so the webview drops that one's late replies. */
  readonly generation: number;
  readonly options: ViewOptions;
  /** Repositories already offered a commit-graph in this window. */
  readonly suggested: Set<string>;
  /** An operation started or ended in this session's repository: the graph shows it whichever repository it shows. */
  readonly busy: (label: string | undefined) => void;
  /** Shows the stash or commit `hash` of the repository `key`, showing that repository first if needed. */
  readonly reveal: (key: RepoKey, hash: string) => void;
  /** Whether the graph is on screen. */
  readonly visible: () => boolean;
}

/**
 * One repository shown in the graph: the `git log` reader for the current history
 * ("generation"), what the graph was told about the repository, and the watchers that reload it.
 * The graph replaces the whole session when it shows another repository.
 *
 * Flows work on the session they started in. Once the graph shows another repository the session
 * is disposed: its flows still run git in its repository and keep its Undo, but nothing reaches
 * the graph or the context keys any more.
 */
export class RepoSession implements vscode.Disposable, FlowHost {
  readonly key: RepoKey;
  private readonly repo: GitRepository;
  private readonly api: GitApi;
  private readonly env: FlowEnv;
  private readonly send: (m: HostToWebview) => void;
  private disposed = false;
  private reader: LogReader | undefined;
  generation: number;
  options: ViewOptions;
  private snapshot: RefSnapshot | undefined;
  private stashList: StashEntry[] = [];
  private readonly stashCache = stashCache();
  /** What the graph was last told is in progress or left behind. */
  private repoState: { operation: OperationState | undefined; leftover: Leftover | undefined } | undefined;
  private gitDirOf: Promise<string> | undefined;
  private commonDirOf: Promise<string> | undefined;
  private running: string | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  /** Watchers of the linked worktrees' folders under the common dir, by folder. */
  private readonly linked = new Map<string, FSWatcher>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** The file last opened from the graph and the URIs of its tab; `shown` is what the graph was told. */
  private opened: { path: string; uris: Set<string> } | undefined;
  private shownFile: string | undefined;
  /** Generation whose first page has been served (and timed). */
  private timedGeneration = -1;
  private readonly suggested: Set<string>;
  private readonly onBusy: (label: string | undefined) => void;
  private readonly revealIn: (key: RepoKey, hash: string) => void;
  private graphTimer: ReturnType<typeof setTimeout> | undefined;
  /** An update is running; `graphAgain` asks for another one when it ends. */
  private graphUpdating = false;
  private graphAgain = false;
  /** What the graph was last told about the uncommitted changes; null before the first time. */
  private changes: ChangesSummary | undefined | null = null;
  /** Stops the status read in flight when a newer one starts. */
  private changesQuery: AbortController | undefined;
  /** Stops the read of the unfolded row's paths when a newer one starts. */
  private changesDetailsQuery: AbortController | undefined;
  /** Untracked files took longer than UNTRACKED_BUDGET_MS to count once. */
  private untrackedSlow = false;
  /** The uncommitted changes may have changed while the graph was hidden. */
  private changesStale = false;
  private readonly visible: () => boolean;
  /** Stops the ref card's where-is query in flight. */
  private whereQuery: AbortController | undefined;
  /** Stops the find widget's search, and its locate query, in flight. */
  private search: AbortController | undefined;
  private locating: AbortController | undefined;
  /** The path history being read: its tips, and the last commit served that changes its paths. */
  private pathRead:
    | {
        generation: number;
        tips: Set<string>;
        oldest: string | undefined;
        done: boolean;
        slow: ReturnType<typeof setTimeout>;
      }
    | undefined;
  /** WHERE_BUDGET_MS; integration tests shorten it to see lines left out. */
  static whereBudgetMs = WHERE_BUDGET_MS;

  constructor(repo: GitRepository, deps: SessionDeps) {
    this.repo = repo;
    this.key = repoKey(repo);
    this.api = deps.api;
    this.env = deps.env;
    this.send = deps.post;
    this.generation = deps.generation;
    this.options = validOptions(deps.options);
    this.suggested = deps.suggested;
    this.onBusy = deps.busy;
    this.revealIn = deps.reveal;
    this.visible = deps.visible;
    void this.context('strata.canUndo', this.lastUndo !== undefined);
    this.disposables.push(
      vscode.window.tabGroups.onDidChangeTabs(() => {
        this.syncShownFile();
      }),
      vscode.window.tabGroups.onDidChangeTabGroups(() => {
        this.syncShownFile();
      }),
      repo.state.onDidChange(() => {
        this.scheduleRefresh();
      }),
      this.watchCommonDir(),
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

  /**
   * What vscode.git does not report: `git stash drop` and `clear` touch only refs/stash and its
   * reflog, and other worktrees switch, commit and lock in their own files under the common dir.
   */
  private watchCommonDir(): vscode.Disposable {
    const watchers: vscode.Disposable[] = [];
    let disposed = false;
    void this.commonDir().then(
      (dir) => {
        if (disposed) return;
        watchers.push(
          this.watchFiles(resolve(dir, 'logs', 'refs'), 'stash'),
          // The main worktree's switches and commits.
          this.watchFiles(resolve(dir, 'logs'), 'HEAD'),
          // Made with the first linked worktree, removed with the last.
          this.watchFiles(dir, 'worktrees', () => {
            void this.watchLinked();
          }),
        );
        void this.watchLinked();
      },
      () => undefined,
    );
    return new vscode.Disposable(() => {
      disposed = true;
      for (const w of watchers.splice(0)) w.dispose();
    });
  }

  /** A watcher of the files `pattern` names in folder `base`, which refreshes the graph on any change. */
  private watchFiles(base: string, pattern: string, also?: () => void): vscode.Disposable {
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), pattern));
    const changed = () => {
      also?.();
      this.scheduleRefresh();
    };
    w.onDidChange(changed);
    w.onDidCreate(changed);
    w.onDidDelete(changed);
    return w;
  }

  /**
   * Watches the folder of each linked worktree under the common dir, as they come and go. With
   * Node's watcher: VS Code's (1.145) reports nothing from a folder of the workspace's .git made
   * after the window opened.
   */
  private async watchLinked(): Promise<void> {
    const dir = await this.commonDir().catch(() => undefined);
    if (dir === undefined) return;
    const base = resolve(dir, 'worktrees');
    const ids = await readdir(base).catch(() => undefined);
    if (this.disposed) return;
    const wanted = new Map<string, readonly string[]>(
      ids === undefined
        ? []
        : [
            [base, []],
            ...ids.flatMap((id) => [
              [resolve(base, id), ['HEAD', 'locked', 'gitdir']] as const,
              [resolve(base, id, 'logs'), ['HEAD']] as const,
            ]),
          ],
    );
    for (const [folder, w] of this.linked)
      if (!wanted.has(folder)) {
        w.close();
        this.linked.delete(folder);
      }
    for (const [folder, names] of wanted) {
      if (this.linked.has(folder)) continue;
      try {
        const w = watch(folder, (_, name) => {
          if (folder === base) void this.watchLinked();
          else if (name !== null && !names.includes(name)) return;
          this.scheduleRefresh();
        });
        // The folder went: the next watchLinked() forgets it.
        w.on('error', () => undefined);
        this.linked.set(folder, w);
      } catch {
        // Gone before it could be watched (a worktree being removed).
      }
    }
  }

  /** Replies arrive after awaits; once the graph shows another repository or is gone, they are not its. */
  private post(m: HostToWebview): void {
    if (!this.disposed) this.send(m);
  }

  private async context(key: ContextKey, value: boolean | string): Promise<void> {
    if (!this.disposed) await setContext(key, value);
  }

  async handle(m: WebviewToHost): Promise<void> {
    try {
      switch (m.type) {
        case 'loadMore':
          if (m.generation === this.generation && this.reader) await this.loadMore(m.generation, m.count);
          break;
        case 'select':
          if (m.generation === this.generation) {
            const read = this.stashes.some((s) => s.hash === m.hash) ? readStashDetails : readCommitDetails;
            const details = await read(this.api.git.path, this.cwd, m.hash);
            if (m.generation === this.generation) this.post({ type: 'details', generation: m.generation, details });
          }
          break;
        case 'selectChanges':
          if (m.generation === this.generation) await this.selectChanges(m.generation);
          break;
        case 'openFile':
          if (m.generation === this.generation) await this.openFile(m);
          break;
        case 'openChange':
          if (m.generation === this.generation) await this.openChange(m.file, m.beside);
          break;
        case 'setOptions': {
          const options = validOptions(m.options);
          // Stash rows are interleaved in the webview: showing or hiding them reloads nothing.
          const reload =
            options.firstParent !== this.options.firstParent ||
            JSON.stringify(options.refs) !== JSON.stringify(this.options.refs) ||
            !samePathFilter(options.path, this.options.path);
          this.options = options;
          if (reload) await this.reset();
          break;
        }
        case 'openPathDiff':
          if (m.generation === this.generation) await this.openPathDiff(m.hash, m.beside);
          break;
        case 'pathAction':
          await this.pathAction(m.action, m.path);
          break;
        case 'pickStash': {
          const hash = await pickStash(this.ui, this.stashes, m.shown, this.snapshot?.headBranch);
          if (hash) this.post({ type: 'reveal', hash });
          break;
        }
        case 'setBadgeRules':
          await this.setBadgeRules(parseRules(m.rules));
          break;
        case 'reachesHead':
          if (m.generation === this.generation) {
            const refs = this.options.refs;
            const reached =
              refs === null || (await refsReach(this.api.git.path, this.cwd, refs, m.hash).catch(() => true));
            if (m.generation === this.generation)
              this.post({ type: 'headReached', generation: m.generation, hash: m.hash, reached });
          }
          break;
        case 'whereIs':
          await this.whereIs(m.generation, m.hash);
          break;
        case 'find':
          await this.find(m.generation, m.id, m.query);
          break;
        case 'findStop':
          this.stopFind();
          break;
        case 'locate':
          await this.locate(m.generation, m.id, m.hash);
          break;
        case 'notShown': {
          if (!isCommitId(m.hash)) throw new Error('invalid commit id');
          const actions = m.action === undefined ? [] : [m.action];
          const clicked = await this.ui.notify(
            'info',
            `Commit ${m.hash.slice(0, 7)} is not in the graph: ${m.message}`,
            ...actions,
          );
          if (clicked !== undefined && clicked === m.action) this.post({ type: 'showNotShown', hash: m.hash });
          break;
        }
        case 'headNotShown': {
          const at = m.branch ?? `detached at ${m.hash.slice(0, 7)}`;
          const action = m.branch === undefined ? 'Show All Branches' : `Show ${m.branch} Too`;
          const clicked = await this.ui.notify(
            'info',
            `HEAD (${at}) is not in the graph: the branch filter leaves it out.`,
            action,
          );
          if (clicked === action) this.post({ type: 'goToHead', include: true });
          break;
        }
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

  /** Loads the history again, from the refs as they are now. */
  async reset(result?: { focus?: string; notified?: true }): Promise<void> {
    if (this.disposed) return;
    this.reader?.dispose();
    this.reader = undefined;
    this.stopWhere();
    this.stopFind();
    const generation = ++this.generation;
    const cwd = this.cwd;
    const [refs, stashes, badgeRules] = await Promise.all([
      readRefs(this.api.git.path, cwd),
      readStashes(this.api.git.path, cwd, this.stashCache),
      this.badgeRules(),
    ]);
    if (generation !== this.generation) return;
    // Undo moves the branch HEAD was on; once HEAD is on another one, it would move the wrong branch.
    if (this.snapshot && refs.headBranch !== this.snapshot.headBranch) this.setUndo(undefined);
    this.snapshot = refs;
    this.stashList = stashes;
    // Drop filtered refs that no longer exist; with none left, show everything.
    const known = new Set(refs.refs.map((r) => r.name));
    const kept = this.options.refs?.filter((r) => known.has(r)) ?? [];
    this.options = { ...this.options, refs: kept.length > 0 ? kept : null };
    const path = this.options.path;
    this.reader = new LogReader(this.view());
    clearTimeout(this.pathRead?.slow);
    this.pathRead = path
      ? {
          generation,
          tips: tipsOf(refs, this.options.refs),
          oldest: undefined,
          done: false,
          slow: setTimeout(() => {
            if (this.pathRead?.generation === generation && !this.pathRead.done) void this.suggestCommitGraph(true);
          }, SLOW_PATH_MS),
        }
      : undefined;
    this.post({
      type: 'reset',
      generation,
      repo: { name: basename(cwd), root: cwd },
      refs,
      options: this.options,
      stashes,
      badgeRules,
      ...(result === undefined ? {} : { result }),
    });
    this.scheduleGraphUpdate();
    await Promise.all([
      this.syncRepoState(true),
      this.syncHead(generation, cwd, refs.headBranch),
      this.syncChanges(true),
    ]);
  }

  /** Shows the history of `path` (null: of the whole repository), keeping the other options. */
  async showPath(path: PathFilter | null): Promise<void> {
    this.options = { ...this.options, path };
    await this.reset();
  }

  /** Serves a page of the current history; a path history's also says which of its ref tips leave the paths alone. */
  private async loadMore(generation: number, count: number): Promise<void> {
    const reader = this.reader!;
    const path = this.options.path;
    const started = performance.now();
    const page = await reader.next(count, path ? { flushAfterMs: PATH_FLUSH_MS } : {}).catch((e: unknown) => {
      // A reset disposed the reader: that history is gone, and the graph is loading the next one.
      if (generation === this.generation) throw e;
    });
    if (!page || generation !== this.generation) return;
    if (this.timedGeneration !== generation) {
      this.timedGeneration = generation;
      if (performance.now() - started > SLOW_FIRST_PAGE_MS) void this.suggestCommitGraph(path !== null);
    }
    const read = this.pathRead;
    if (!path || read?.generation !== generation) {
      this.post({ type: 'commits', generation, ...page });
      return;
    }
    // Ref tips are kept for their badges, and merges that join kept lines for the graph, whether or
    // not they change the paths.
    const kept = page.commits.filter((c) => read.tips.has(c.hash) || c.parents.length > 1).map((c) => c.hash);
    const changing = await changingCommits(this.api.git.path, this.cwd, kept, path, this.options.firstParent);
    if (generation !== this.generation) return;
    const unchanged = kept.filter((h) => !changing.has(h));
    const skip = new Set(unchanged);
    read.oldest = page.commits.findLast((c) => !skip.has(c.hash))?.hash ?? read.oldest;
    this.post({ type: 'commits', generation, ...page, ...(unchanged.length > 0 ? { unchanged } : {}) });
    if (page.done) {
      read.done = true;
      void this.sendPathOrigin(generation, path, read.oldest);
    }
  }

  /** Tells the graph how the path history it has read to the end starts. */
  private async sendPathOrigin(generation: number, path: PathFilter, oldest: string | undefined): Promise<void> {
    const git = this.api.git.path;
    const cwd = this.cwd;
    try {
      const origin =
        oldest === undefined
          ? { kind: 'never' as const, tracked: await isTracked(git, cwd, path) }
          : await readPathOrigin(git, cwd, oldest, path, await isPartialClone(git, cwd));
      if (generation === this.generation) this.post({ type: 'pathOrigin', generation, origin });
    } catch {
      // Without it the history simply has no note at its end.
    }
  }

  /** Opens the change a commit of a one-file path history made to that file. */
  private async openPathDiff(hash: string, beside: boolean): Promise<void> {
    const path = this.options.path;
    if (!isCommitId(hash) || !path) throw new Error('invalid commit id');
    const details = await readCommitDetails(this.api.git.path, this.cwd, hash);
    const file = details.files.find((f) => inFilter(f.path, path));
    if (!file) throw new Error(`${shortOf(hash)} does not change ${path.paths[0]}`);
    await this.openFileFromMenu(hash, details.base, file, 'primary', beside);
  }

  /** Opens or copies a path of the filter shown. */
  private async pathAction(action: 'open' | 'copy', raw: string): Promise<void> {
    const path = this.options.path?.paths.find((p) => p === raw);
    if (path === undefined) throw new Error(`not in the path filter: ${raw}`);
    if (action === 'copy') {
      await vscode.env.clipboard.writeText(path);
      this.notify(DONE.copied(path));
      return;
    }
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(this.absolutePath(path)));
  }

  /** Sets `strata.head`, which picks the title bar's Pull and Push or Publish Branch. */
  private async syncHead(generation: number, cwd: string, branch: string | undefined): Promise<void> {
    // readUpstream, not the snapshot: for-each-ref has no upstream given by URL or not fetched.
    const upstream =
      branch === undefined ? undefined : await readUpstream(this.api.git.path, cwd, branch).catch(() => undefined);
    if (generation !== this.generation) return;
    await this.context('strata.head', branch === undefined ? 'detached' : upstream ? 'tracking' : 'branch');
  }

  /** Tells the graph and the `strata.operation` context key which operation is in progress; `force` even if unchanged. */
  private async syncRepoState(force: boolean): Promise<void> {
    const cwd = this.cwd;
    const [operation, unmerged, dir] = await Promise.all([
      readOperationState(this.api.git.path, cwd).catch(() => undefined),
      readUnmerged(this.api.git.path, cwd).catch(() => []),
      this.gitDir().catch(() => undefined),
    ]);
    if (this.disposed) return;
    // A running flow's own stash is not a leftover, and its marks are the flow's to change.
    let leftover: Leftover | undefined;
    if (this.running === undefined && dir !== undefined) {
      const marks = settleMarks(this.marksOf(dir), operation, new Set(this.stashes.map((s) => s.hash)));
      await this.setMarks(dir, marks);
      leftover = leftoverOf({
        operation,
        stashes: this.stashes,
        unmerged,
        marks,
        headBranch: this.snapshot?.headBranch,
      });
    }
    // A running flow's own steps are not an operation that stopped; it reports how it ended.
    const state = { operation: this.running === undefined ? operation : this.repoState?.operation, leftover };
    if (!force && JSON.stringify(state) === JSON.stringify(this.repoState)) return;
    this.repoState = state;
    this.post({ type: 'repoState', ...state });
    await this.context('strata.operation', state.operation?.kind ?? '');
  }

  /**
   * Tells the graph about the uncommitted changes; `force` even if unchanged (after a reset).
   * Unforced, a hidden graph is not told: it reads them once it is shown again (shown()).
   */
  private async syncChanges(force: boolean): Promise<void> {
    if (!force && !this.visible()) {
      this.changesStale = true;
      return;
    }
    this.changesStale = false;
    this.changesQuery?.abort();
    const query = new AbortController();
    this.changesQuery = query;
    const generation = this.generation;
    const changes = await this.readChanges(query.signal);
    if (query.signal.aborted || this.disposed || generation !== this.generation) return;
    this.changesQuery = undefined;
    if (changes === null) return;
    if (!force && JSON.stringify(changes) === JSON.stringify(this.changes)) return;
    this.changes = changes;
    this.post({ type: 'changes', generation, changes });
  }

  /** Answers selectChanges; a newer request stops this one's git. */
  private async selectChanges(generation: number): Promise<void> {
    this.changesDetailsQuery?.abort();
    const query = new AbortController();
    this.changesDetailsQuery = query;
    let details: WorkingDetails;
    try {
      const status = await readGraphStatus(this.api.git.path, this.cwd, {
        untracked: this.scansUntracked(),
        limits: { signal: query.signal },
      });
      details = listChanges(status, CHANGES_LISTED);
    } catch (e) {
      if (query.signal.aborted) return;
      throw e;
    }
    if (query.signal.aborted || generation !== this.generation) return;
    this.changesDetailsQuery = undefined;
    this.post({ type: 'changesDetails', generation, details });
  }

  /** Opens an uncommitted change (openChange). */
  private async openChange(file: ChangedPath, beside: boolean): Promise<void> {
    // From the webview: only paths inside the repository, of the groups and statuses git reports.
    const folder = file.group === 'untracked' && file.path.endsWith('/');
    for (const p of [folder ? file.path.slice(0, -1) : file.path, file.oldPath]) {
      if (p !== undefined && !isRepoPath(p)) throw new Error(`invalid path: ${p}`);
    }
    if (!['staged', 'unstaged', 'conflicted', 'untracked'].includes(file.group)) throw new Error('invalid group');
    const uri = (path: string) => vscode.Uri.joinPath(this.repo.rootUri, ...path.split('/').filter((s) => s));
    if (file.group === 'conflicted') {
      await resolveConflicts(this, [file.path]);
      return;
    }
    // A repository nested in this one shows as one untracked folder.
    if (folder) {
      await vscode.commands.executeCommand('revealInExplorer', uri(file.path));
      return;
    }
    const opened = new Set<string>();
    this.opened = { path: file.path, uris: opened };
    const seen = (u: vscode.Uri) => {
      opened.add(u.toString());
      return u;
    };
    const options: vscode.TextDocumentShowOptions = {
      preview: true,
      ...(beside ? { viewColumn: vscode.ViewColumn.Beside } : {}),
    };
    const name = posix.basename(file.path);
    const open = (u: vscode.Uri, title: string) =>
      vscode.commands.executeCommand('vscode.open', seen(u), options, title);
    const diff = (left: vscode.Uri, right: vscode.Uri, title: string) =>
      vscode.commands.executeCommand('vscode.diff', seen(left), seen(right), title, options);
    // The resources and titles Source Control uses for the same change.
    const index = this.api.toGitUri(uri(file.path), '');
    if (file.group === 'staged') {
      const head = this.api.toGitUri(uri(file.oldPath ?? file.path), 'HEAD');
      const label = file.oldPath ? `${posix.basename(file.oldPath)} → ${name}` : name;
      if (file.status === 'A') await open(index, `${name} (Index)`);
      else if (file.status === 'D') await open(head, `${name} (Deleted)`);
      else await diff(head, index, `${label} (Index)`);
    } else if (file.group === 'unstaged') {
      const indexed = this.api.toGitUri(uri(file.path), '~');
      if (file.status === 'D') await open(indexed, `${name} (Deleted)`);
      else if (file.status === 'A') await open(seen(uri(file.path)), name);
      else await diff(indexed, uri(file.path), `${name} (Working Tree)`);
    } else await open(uri(file.path), name);
    this.syncShownFile();
  }

  /** Whether the graph counts and lists untracked files: as Source Control does, unless they were too slow to count. */
  private scansUntracked(): boolean {
    return !this.untrackedSlow && vscode.workspace.getConfiguration('git').get<string>('untrackedChanges') !== 'hidden';
  }

  /** The uncommitted changes; undefined without a work tree, null when the read was stopped. */
  private async readChanges(signal: AbortSignal): Promise<ChangesSummary | undefined | null> {
    const git = this.api.git.path;
    const cwd = this.cwd;
    const read = async (untracked: boolean, timeoutMs?: number) =>
      parseStatus(
        await readGraphStatus(git, cwd, {
          untracked,
          limits: { signal, ...(timeoutMs ? { timeoutMs } : {}) },
        }),
        untracked,
      );
    try {
      if (!this.scansUntracked()) return changesSummary(await read(false));
      const started = performance.now();
      try {
        return changesSummary(await read(true, UNTRACKED_BUDGET_MS));
      } catch (e) {
        if (signal.aborted || performance.now() - started < UNTRACKED_BUDGET_MS) throw e;
        this.untrackedSlow = true;
        return changesSummary(await read(false));
      }
    } catch {
      return signal.aborted ? null : undefined;
    }
  }

  /**
   * The git dir of the graph's worktree, which Strata's stash marks belong to: the stash list is
   * shared by every worktree of a repository, but each worktree has its own git dir.
   */
  private gitDir(): Promise<string> {
    const root = this.cwd;
    return (this.gitDirOf ??= runGit(this.api.git.path, root, ['rev-parse', '--git-dir']).then((d) =>
      resolve(root, d.trim()),
    ));
  }

  /** The git dir shared by every worktree of the repository, absolute. */
  private commonDir(): Promise<string> {
    const root = this.cwd;
    return (this.commonDirOf ??= runGit(this.api.git.path, root, ['rev-parse', '--git-common-dir']).then((d) =>
      resolve(root, d.trim()),
    ));
  }

  /** The repository's badge rules; none when its git dir cannot be read. */
  private async badgeRules(): Promise<BadgeRule[]> {
    const dir = await this.commonDir().catch(() => undefined);
    if (dir === undefined) return [];
    return this.env.badgeRules.get(dir);
  }

  /** Adds a rule hiding the badge of `ref`: its short name, free of * and ?, matches only it. */
  async hideBadge(ref: Ref): Promise<void> {
    const dir = await this.commonDir();
    await this.setBadgeRules(addRule(this.env.badgeRules.get(dir), { pattern: ref.short, keep: false }));
  }

  /** Replaces the graph's repository's badge rules and tells the graph. */
  private async setBadgeRules(rules: BadgeRule[]): Promise<void> {
    const dir = await this.commonDir();
    await this.env.badgeRules.set(dir, rules);
    // An answer under the old rules could name a tag the new ones hide.
    this.stopWhere();
    this.post({ type: 'badgeRules', rules });
  }

  /** Answers whereIs: where commit `hash` is, for the ref card. */
  private async whereIs(generation: number, hash: string | undefined): Promise<void> {
    this.stopWhere();
    const snapshot = this.snapshot;
    if (hash === undefined || generation !== this.generation || !snapshot) return;
    if (!isCommitId(hash)) throw new Error('invalid commit id');
    const query = new AbortController();
    this.whereQuery = query;
    const hidden = hiddenRefs(await this.badgeRules(), snapshot);
    const where = await readWhere(this.api.git.path, this.cwd, hash, snapshot, hidden, {
      timeoutMs: RepoSession.whereBudgetMs,
      signal: query.signal,
    });
    if (query.signal.aborted || generation !== this.generation) return;
    this.whereQuery = undefined;
    this.post({ type: 'where', generation, hash, where });
  }

  private stopWhere(): void {
    this.whereQuery?.abort();
    this.whereQuery = undefined;
  }

  /** The history shown, as LogReader reads it. */
  private view(): LogOptions {
    return {
      git: this.api.git.path,
      cwd: this.cwd,
      firstParent: this.options.firstParent,
      refs: this.options.refs ?? undefined,
      heads: this.snapshot?.worktrees.flatMap((w) => (w.branch === undefined && w.head !== undefined ? [w.head] : [])),
      paths: this.options.path?.paths,
    };
  }

  /** Answers find: streams the commits of the history shown that `query` matches. */
  private async find(generation: number, id: number, query: FindQuery): Promise<void> {
    this.search?.abort();
    this.search = undefined;
    if (generation !== this.generation) return;
    // The query comes from the webview: only strings reach git, each as one option's value.
    const { text, author, hashPrefix } = query;
    if (typeof text !== 'string' || (author !== undefined && typeof author !== 'string'))
      throw new Error('invalid find query');
    const search = new AbortController();
    this.search = search;
    const live = () => !search.signal.aborted && generation === this.generation;
    let exact: FindHit[] | undefined;
    try {
      exact = hashPrefix === undefined ? undefined : await findExact(this.api.git.path, this.cwd, hashPrefix);
      if (!live()) return;
      await findCommits(
        { ...this.view(), query: { text, author, hashPrefix }, cap: FIND_CAP, signal: search.signal },
        (batch) => {
          this.post({ type: 'findHits', generation, id, ...batch, ...(exact ? { exact } : {}) });
          exact = undefined;
        },
      );
    } catch (e) {
      if (!live()) return;
      // The widget stops waiting; the error shows in the toolbar.
      this.post({ type: 'findHits', generation, id, hits: [], done: true, capped: false, ...(exact ? { exact } : {}) });
      throw e;
    }
  }

  /** Answers locate: where commit `hash` is in the history shown. */
  private async locate(generation: number, id: number, hash: string): Promise<void> {
    this.locating?.abort();
    if (generation !== this.generation) return;
    if (!isCommitId(hash)) throw new Error('invalid commit id');
    const query = new AbortController();
    this.locating = query;
    const located = await locateCommit({ ...this.view(), hash, signal: query.signal }).catch((e: unknown) => {
      if (!query.signal.aborted) throw e;
    });
    if (!located || generation !== this.generation) return;
    this.post({ type: 'located', generation, id, hash, ...located });
  }

  private stopFind(): void {
    this.search?.abort();
    this.search = undefined;
    this.locating?.abort();
    this.locating = undefined;
  }

  private marksOf(dir: string): StashMark[] {
    return this.env.state.get<Record<string, StashMark[]>>(STASH_MARKS)?.[dir] ?? [];
  }

  private async setMarks(dir: string, marks: StashMark[]): Promise<void> {
    if (JSON.stringify(marks) === JSON.stringify(this.marksOf(dir))) return;
    const all = { ...this.env.state.get<Record<string, StashMark[]>>(STASH_MARKS) };
    if (marks.length > 0) all[dir] = marks;
    else Reflect.deleteProperty(all, dir);
    await this.env.state.update(STASH_MARKS, all);
  }

  /** Gives the stash commit `hash` this mark (none: forgets it). */
  private async mark(hash: string, mark: StashMark | undefined): Promise<void> {
    const dir = await this.gitDir();
    const others = this.marksOf(dir).filter((m) => m.hash !== hash);
    await this.setMarks(dir, mark ? [...others, mark] : others);
    await this.syncRepoState(false);
  }

  readonly leftovers: Leftovers = {
    pushed: (hash, head) => this.mark(hash, { kind: 'pushed', hash, ...(head === undefined ? {} : { head }) }),
    held: async (operation) => heldBy(this.marksOf(await this.gitDir()), operation)?.hash,
    markRestoreConflicted: (hash) => this.mark(hash, { kind: 'restoreConflicted', hash }),
    keep: (hash) => this.mark(hash, undefined),
  };

  reveal(hash: string): void {
    this.revealIn(this.key, hash);
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
    if (this.disposed) return;
    if (this.graphUpdating) {
      this.graphAgain = true;
      return;
    }
    this.graphUpdating = true;
    try {
      await updateCommitGraph(this.api.git.path, this.cwd);
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

  /**
   * Repository state events fire for index and working tree changes too: only ref changes reload
   * the history, and stash changes alone only re-interleave the rows.
   */
  private scheduleRefresh(): void {
    if (this.disposed) return;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      void this.refreshIfChanged();
    }, REFRESH_DEBOUNCE_MS);
  }

  private async refreshIfChanged(): Promise<void> {
    // A running flow refreshes when it ends; busy(undefined) checks again for one that failed.
    if (this.running !== undefined) return;
    const generation = this.generation;
    const cwd = this.cwd;
    try {
      const [refs, stashes] = await Promise.all([
        readRefs(this.api.git.path, cwd),
        readStashes(this.api.git.path, cwd, this.stashCache),
      ]);
      if (generation !== this.generation) return;
      if (JSON.stringify(refs) !== JSON.stringify(this.snapshot)) {
        await this.reset();
        return;
      }
      if (JSON.stringify(stashes) !== JSON.stringify(this.stashes)) {
        this.stashList = stashes;
        this.post({ type: 'stashes', generation, stashes });
      }
      await Promise.all([this.syncRepoState(false), this.syncChanges(false)]);
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
  private async openFile(m: Extract<WebviewToHost, { type: 'openFile' }>): Promise<void> {
    const { file, hash, base } = m;
    // Everything here came from the webview: only well-formed commit ids and paths inside the repository.
    if (!isCommitId(hash) || (base !== undefined && !isCommitId(base))) throw new Error('invalid commit id');
    for (const p of [file.path, file.oldPath]) {
      if (p !== undefined && !isRepoPath(p)) throw new Error(`invalid path: ${p}`);
    }
    if (!fileViews(file, base).includes(m.view)) throw new Error(`cannot open ${m.view} of ${file.path}`);
    const uri = (path: string) => vscode.Uri.joinPath(this.repo.rootUri, ...path.split('/'));
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
    const resolved = view === 'primary' ? fileViews(file, base)[0]! : view;
    await this.openFile({
      type: 'openFile',
      generation: this.generation,
      hash,
      base,
      file,
      view: resolved,
      beside,
    });
  }

  /** A folder on the machine the repository is on (a remote one too), by the path git prints. */
  folderUri(path: string): vscode.Uri {
    return this.repo.rootUri.with({ path: vscode.Uri.file(path).path });
  }

  /** Absolute file system path of a repository-relative path. */
  absolutePath(path: string): string {
    return vscode.Uri.joinPath(this.repo.rootUri, ...path.split('/')).fsPath;
  }

  /** Shortest unambiguous abbreviation of a commit id, as git prints it. */
  async shortHash(hash: string): Promise<string> {
    return (await runGit(this.api.git.path, this.cwd, ['rev-parse', '--short', hash])).trim();
  }

  /** Copies the commit as an email patch (a merge against its first parent). */
  async copyCommitPatch(hash: string): Promise<void> {
    const cwd = this.cwd;
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

  /** Copies a stash's tracked and untracked changes as one plain diff. */
  async copyStashPatch(hash: string): Promise<void> {
    const s = this.stashes.find((e) => e.hash === hash);
    const [patch, short] = await Promise.all([
      readPatch(readStashPatch(this.api.git.path, this.cwd, hash)),
      this.shortHash(hash),
    ]);
    await this.copyPatch(patch, s ? `stash@{${s.index}}` : `stash ${short}`, `stash-${short}.patch`);
  }

  /** Show Stashes from the palette or title bar: only the webview knows which stash rows it draws. */
  showStashes(): void {
    this.post({ type: 'pickStash' });
  }

  /** Copies the change to one file of a commit as a plain diff. */
  async copyFilePatch(hash: string, base: string | undefined, file: FileChange): Promise<void> {
    const [patch, short] = await Promise.all([
      readPatch(readFilePatch(this.api.git.path, this.cwd, hash, base, file)),
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
          defaultUri: vscode.Uri.joinPath(this.repo.rootUri, fileName),
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

  get git(): string {
    return this.api.git.path;
  }

  get cwd(): string {
    return this.key;
  }

  get ui() {
    return this.env.ui;
  }

  get runner() {
    return this.env.runner;
  }

  get refs(): RefSnapshot {
    if (!this.snapshot) throw new Error('the commit graph has not loaded a repository');
    return this.snapshot;
  }

  get stashes(): readonly StashEntry[] {
    return this.stashList;
  }

  get lastUndo(): Undo | undefined {
    return this.env.undos.get(this.key);
  }

  /** Output lines name the repository when there is more than one to tell apart. */
  get repoName(): string | undefined {
    return this.api.repositories.length > 1 ? basename(this.cwd) : undefined;
  }

  settings(): FlowSettings {
    const strata = vscode.workspace.getConfiguration('strata');
    const git = vscode.workspace.getConfiguration('git');
    const autoStash = strata.get<string>('autoStash', 'gitConfig');
    return {
      autoStash: AUTOSTASH.includes(autoStash) ? (autoStash as AutostashSetting) : 'gitConfig',
      branchPrefix: git.get<string>('branchPrefix', ''),
      allowForcePush: git.get<boolean>('allowForcePush', false),
      mergeEditor: git.get<boolean>('mergeEditor', false),
    };
  }

  refresh(focus?: string, notified = false): Promise<void> {
    return this.reset({ ...(focus === undefined ? {} : { focus }), ...(notified ? { notified: true } : {}) });
  }

  done(message: string): void {
    this.notify(message);
  }

  setUndo(undo: Undo | undefined): void {
    if (undo) this.env.undos.set(this.key, undo);
    else this.env.undos.delete(this.key);
    void this.context('strata.canUndo', undo !== undefined);
  }

  openEditor(draft: MessageDraft): void {
    this.post({ type: 'editMessage', draft });
  }

  editEffects(head: string, effects: string): void {
    this.post({ type: 'editEffects', head, effects });
  }

  editEnded(applied: boolean): void {
    this.post({ type: 'editEnded', applied });
  }

  busy(label: string | undefined): void {
    this.running = label;
    this.onBusy(label);
    if (label === undefined) this.scheduleRefresh();
  }

  /**
   * Writes a commit-graph with progress, then reloads the history. `changedPaths`: with the
   * changed-path filters file and folder history need (several times longer to write).
   */
  async writeCommitGraph(changedPaths: boolean): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Strata: writing commit-graph${changedPaths ? ' with changed-path filters' : ''} for ${basename(this.cwd)}…`,
      },
      () => writeCommitGraph(this.api.git.path, this.cwd, changedPaths),
    );
    await this.reset();
  }

  /**
   * Offers, once per repository and window, to write a commit-graph when history is slow; for a
   * slow path history (`forPaths`), also changed-path filters, also into an existing commit-graph.
   */
  private async suggestCommitGraph(forPaths: boolean): Promise<void> {
    if (this.suggested.has(this.key)) return;
    const config = vscode.workspace.getConfiguration('strata');
    if (!config.get<boolean>('suggestCommitGraph', true)) return;
    const git = this.api.git.path;
    const graph = await hasCommitGraph(git, this.cwd);
    if (graph && (!forPaths || (await hasChangedPaths(git, this.cwd)))) return;
    this.suggested.add(this.key);
    const never = "Don't ask again";
    const offer = graph
      ? COMMIT_GRAPH_OFFER.filters(this.pathName())
      : COMMIT_GRAPH_OFFER.graph(basename(this.cwd), forPaths);
    const choice = await vscode.window.showInformationMessage(offer.message, ...offer.buttons, 'Not now', never);
    if (choice === COMMIT_GRAPH_OFFER.keep)
      await config.update('keepCommitGraphUpdated', true, vscode.ConfigurationTarget.Global);
    if (choice !== undefined && offer.buttons.includes(choice)) await this.writeCommitGraph(forPaths);
    else if (choice === never) await config.update('suggestCommitGraph', false, vscode.ConfigurationTarget.Global);
  }

  /** The path whose history is shown, as offers name it. */
  private pathName(): string {
    return this.options.path?.paths[0] ?? basename(this.cwd);
  }

  /** The graph came back on screen: what changed meanwhile reaches it now. */
  shown(): void {
    if (this.changesStale) void this.syncChanges(false);
  }

  dispose(): void {
    this.disposed = true;
    this.stopWhere();
    this.stopFind();
    this.changesQuery?.abort();
    this.changesDetailsQuery?.abort();
    clearTimeout(this.refreshTimer);
    clearTimeout(this.graphTimer);
    clearTimeout(this.pathRead?.slow);
    this.reader?.dispose();
    for (const d of this.disposables.splice(0)) d.dispose();
    for (const w of this.linked.values()) w.close();
    this.linked.clear();
  }
}

/** `o` with a path filter only when it is a valid one: options come from the webview and saved state. */
export function validOptions(o: ViewOptions): ViewOptions {
  return { ...o, path: parsePathFilter(o.path) ?? null };
}

/** Commits a path history keeps for their badges: the tips of the refs shown (branches and remote-tracking branches by default) and HEAD. */
function tipsOf(snapshot: RefSnapshot, refs: string[] | null): Set<string> {
  const shown = (r: Ref) => (refs ? refs.includes(r.name) : r.kind === 'branch' || r.kind === 'remote');
  const tips = new Set(snapshot.refs.filter(shown).map((r) => r.hash));
  if (snapshot.head !== undefined) tips.add(snapshot.head);
  return tips;
}

const shortOf = (hash: string) => hash.slice(0, 7);

/** runGit's output cap is the patch size limit; its error does not say so. */
function readPatch(read: Promise<string>): Promise<string> {
  return read.catch((e: unknown) => {
    if (e instanceof Error && /maxBuffer/i.test(e.message))
      throw new Error('The patch is larger than 64 MB and cannot be copied.');
    throw e;
  });
}
