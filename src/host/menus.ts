import * as vscode from 'vscode';
import type { FileChange, FileStatus, FileView } from '../core/details.ts';
import { canWrite, parseGitVersion, type GitVersion } from '../core/git-version.ts';
import { conflictsInProgress, DONE, gitTooOld, operationInProgress } from '../core/wording.ts';
import { isCommitId } from '../git/details.ts';
import { readUnmerged } from '../git/facts.ts';
import { runGit } from '../git/run.ts';
import { readOperationState } from '../git/state.ts';
import { COMMAND_IDS, type CommandId } from '../shared/commands.ts';
import { isRepoPath } from './controller.ts';
import { fail, undoLast, type FlowEnv, type FlowHost } from './flow.ts';
import {
  checkoutBranch,
  checkoutDetached,
  checkoutRemote,
  copyRefName,
  createBranch,
  createTag,
  deleteBranch,
  deleteTag,
  refActionsOf,
  renameBranch,
} from './flows/refs.ts';
import { resolveConflicts } from './flows/changes.ts';
import {
  abortOperation,
  atShallowEdge,
  continueOperation,
  merge,
  pick,
  rebase,
  reset,
  skipCommit,
  sourceOf,
} from './flows/history.ts';
import { deleteRemoteBranch, fetchRemote, publish, pull, push } from './flows/remote.ts';
import { dropStash, restoreStash, stashBranch, stashPush } from './flows/stash.ts';
import { remoteBranch } from '../core/remote-branch.ts';
import { GraphPanel } from './panel.ts';
import { parseTarget, type TargetKind, type TargetOf } from './target.ts';

/** A context menu argument: the clicked element's data-vscode-context (set by the webview) plus the webview id. */
type MenuArg = Record<string, unknown> | undefined;

const STATUSES: readonly string[] = ['A', 'M', 'D', 'R', 'C', 'T'] satisfies FileStatus[];

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The changed file a menu was opened on. The context comes from the webview, so it is validated like any request. */
function fileArg(ctx: MenuArg): { hash: string; base: string | undefined; file: FileChange } {
  const hash = str(ctx?.['strataHash']);
  const base = str(ctx?.['strataBase']);
  const path = str(ctx?.['strataPath']);
  const oldPath = str(ctx?.['strataOldPath']);
  const status = str(ctx?.['strataStatus']);
  if (!hash || !isCommitId(hash) || (base !== undefined && !isCommitId(base))) throw new Error('invalid commit id');
  if (!path || !isRepoPath(path) || (oldPath !== undefined && !isRepoPath(oldPath))) throw new Error('invalid path');
  if (!status || !STATUSES.includes(status)) throw new Error('invalid file status');
  const file: FileChange = { status: status as FileStatus, path, ...(oldPath === undefined ? {} : { oldPath }) };
  return { hash, base, file };
}

function commitArg(ctx: MenuArg): { hash: string; subject: string } {
  const hash = str(ctx?.['strataHash']);
  if (!hash || !isCommitId(hash)) throw new Error('invalid commit id');
  return { hash, subject: str(ctx?.['strataSubject']) ?? '' };
}

function panel(): GraphPanel {
  if (!GraphPanel.current) throw new Error('the commit graph is not open');
  return GraphPanel.current;
}

const open = (view: FileView | 'primary', beside: boolean) => (ctx: MenuArg) => {
  const { hash, base, file } = fileArg(ctx);
  return panel().openFile(hash, base, file, view, beside);
};

/** Copies `text` and then, once the clipboard has it, says what was copied. */
const copy =
  (text: (ctx: MenuArg) => string | Promise<string>, said: (text: string, ctx: MenuArg) => string | Promise<string>) =>
  async (ctx: MenuArg) => {
    const t = await text(ctx);
    await vscode.env.clipboard.writeText(t);
    panel()
      .flowHost()
      .done(await said(t, ctx));
  };

const shortOf = (ctx: MenuArg) => panel().shortHash(commitArg(ctx).hash);

let gitVersion: Promise<GitVersion | undefined> | undefined;
let toldGitTooOld = false;

/** Write operations need git 2.27; an older one is named once per session, then in the status bar. */
async function gitCanWrite(host: FlowHost): Promise<boolean> {
  gitVersion ??= runGit(host.git, host.cwd, ['version']).then(parseGitVersion);
  const v = await gitVersion;
  // An unparsable version is left for git itself to judge.
  if (!v || canWrite(v)) return true;
  const message = gitTooOld(v.join('.'));
  if (toldGitTooOld) vscode.window.setStatusBarMessage(message, 5000);
  else void host.ui.notify('error', message);
  toldGitTooOld = true;
  return false;
}

/**
 * While an operation is stopped or files are unmerged, other writes wait: says why and offers
 * the way on. Resolves true when the write must not run.
 */
async function blocked(host: FlowHost): Promise<boolean> {
  const state = await readOperationState(host.git, host.cwd);
  if (state) {
    const answer = await host.ui.confirm(operationInProgress(state.kind, state.step));
    if (answer === 'continue') await continueOperation(host);
    else if (answer === 'abort') await abortOperation(host);
    return true;
  }
  const unmerged = await readUnmerged(host.git, host.cwd);
  if (unmerged.length === 0) return false;
  if (await host.ui.confirm(conflictsInProgress(unmerged, unmerged.length))) await resolveConflicts(host, unmerged);
  return true;
}

/**
 * A command that changes the repository; failures are shown by the graph, which refreshes when it
 * was outdated. Only `whileStopped` commands (the ways out of a stop) run while one is pending.
 */
const write =
  (flow: (host: FlowHost, ctx: MenuArg) => Promise<void>, opts: { whileStopped?: true } = {}) =>
  async (ctx: MenuArg) => {
    const host = panel().flowHost();
    if (!(await gitCanWrite(host))) return;
    try {
      if (!opts.whileStopped && (await blocked(host))) return;
      await flow(host, ctx);
    } catch (e) {
      await fail(host, e);
    }
  };

/** The menu target of a command that also runs from the palette or title bar (no menu context there). */
const optionalTarget = <K extends TargetKind>(ctx: MenuArg, kinds: readonly K[], host: FlowHost) =>
  typeof ctx?.['webviewSection'] === 'string' ? parseTarget(ctx, kinds, host.refs) : undefined;

/** A stash commit named by a banner button (`strataHash`). */
const stashHash = (ctx: MenuArg): string => {
  const hash = str(ctx?.['strataHash']);
  if (!hash || !isCommitId(hash)) throw new Error('invalid stash id');
  return hash;
};

/** A write command on a menu target of one of `kinds`. */
const on = <K extends TargetKind>(kinds: readonly K[], flow: (host: FlowHost, t: TargetOf<K>) => Promise<void>) =>
  write((host, ctx) => flow(host, parseTarget(ctx, kinds, host.refs)));

type Handlers = Record<CommandId, (ctx: MenuArg) => unknown>;

const handlers = (env: FlowEnv): Handlers => ({
  'strata.file.openChanges': open('diff', false),
  'strata.file.openOld': open('before', false),
  'strata.file.openNew': open('after', false),
  'strata.file.openToSide': open('primary', true),
  'strata.file.copyRelativePath': copy((ctx) => fileArg(ctx).file.path, DONE.copied),
  'strata.file.copyPath': copy((ctx) => panel().absolutePath(fileArg(ctx).file.path), DONE.copied),
  'strata.file.copyOldRelativePath': copy((ctx) => {
    const { file } = fileArg(ctx);
    if (file.oldPath === undefined) throw new Error('not a rename');
    return file.oldPath;
  }, DONE.copied),
  'strata.file.copyPatch': async (ctx) => {
    const { hash, base, file } = fileArg(ctx);
    // Against its parent: a shallow clone's oldest commit has none here.
    if (base === undefined && (await atShallowEdge(panel().flowHost(), hash, file.path))) return;
    await panel().copyFilePatch(hash, base, file);
  },
  'strata.commit.copyHash': copy(
    (ctx) => commitArg(ctx).hash,
    async (_, ctx) => DONE.copiedHash(await shortOf(ctx)),
  ),
  'strata.commit.copyShortHash': copy(shortOf, DONE.copiedShortHash),
  'strata.commit.copySubject': copy(
    (ctx) => commitArg(ctx).subject,
    async (_, ctx) => DONE.copiedSubject(await shortOf(ctx)),
  ),
  'strata.commit.copyPatch': async (ctx) => {
    const { hash } = commitArg(ctx);
    if (!(await atShallowEdge(panel().flowHost(), hash))) await panel().copyCommitPatch(hash);
  },

  'strata.checkout': on(['branch', 'remoteBranch'], (host, t) =>
    t.kind === 'branch' ? checkoutBranch(host, t.ref) : checkoutRemote(host, t.ref),
  ),
  'strata.checkoutDetached': on(['commit', 'tag'], (host, t) =>
    checkoutDetached(host, t.kind === 'commit' ? t.hash : t.ref.name),
  ),
  'strata.createBranch': on(['commit', 'head'], (host, t) => createBranch(host, t.hash)),
  'strata.createTag': on(['commit'], (host, t) => createTag(host, t.hash)),
  'strata.renameBranch': on(['branch'], (host, t) => renameBranch(host, t.ref)),
  'strata.copyRefName': (ctx) => {
    const host = panel().flowHost();
    return copyRefName(host, parseTarget(ctx, ['branch', 'remoteBranch', 'tag'], host.refs).ref);
  },
  'strata.deleteBranch': on(['branch'], (host, t) => deleteBranch(host, t.ref)),
  'strata.deleteTag': on(['tag'], (host, t) => deleteTag(host, t.ref)),
  'strata.deleteRemoteBranch': on(['remoteBranch'], (host, t) => deleteRemoteBranch(host, t.ref)),
  'strata.refActions': (ctx) => {
    const host = panel().flowHost();
    // A row's menu names all its refs; a "+N" badge's, the ones it hides.
    if (ctx?.['webviewSection'] !== 'refs') parseTarget(ctx, ['commit'], host.refs);
    return refActionsOf(host, (str(ctx?.['strataRefs']) ?? '').split(' ').filter(Boolean));
  },

  'strata.merge': on(['commit', 'branch', 'remoteBranch'], async (host, t) => merge(host, await sourceOf(host, t))),
  'strata.rebase': on(['commit', 'branch', 'remoteBranch'], async (host, t) => rebase(host, await sourceOf(host, t))),
  'strata.cherryPick': on(['commit'], (host, t) => pick(host, 'cherryPick', t.hash)),
  'strata.revert': on(['commit'], (host, t) => pick(host, 'revert', t.hash)),
  'strata.reset': on(['commit'], (host, t) => reset(host, t.hash)),
  'strata.operation.continue': write(continueOperation, { whileStopped: true }),
  'strata.operation.abort': write(abortOperation, { whileStopped: true }),
  'strata.operation.skip': write(skipCommit, { whileStopped: true }),
  'strata.stash.push': write((host) => stashPush(host, false)),
  'strata.stash.pushUntracked': write((host) => stashPush(host, true)),
  'strata.stash.apply': on(['stash'], (host, t) => restoreStash(host, t.hash, false)),
  'strata.stash.pop': write((host, ctx) => restoreStash(host, stashHash(ctx), true)),
  'strata.stash.branch': on(['stash'], (host, t) => stashBranch(host, t.hash)),
  'strata.stash.copyPatch': (ctx) => {
    const host = panel().flowHost();
    return panel().copyStashPatch(parseTarget(ctx, ['stash'], host.refs).hash);
  },
  'strata.stash.drop': write((host, ctx) => dropStash(host, stashHash(ctx))),
  'strata.showStashes': () => {
    panel().showStashes();
  },
  'strata.fetch': write((host, ctx) => {
    const t = optionalTarget(ctx, ['remoteBranch'], host);
    return fetchRemote(host, t && remoteBranch(t.ref.name, host.refs.remotes)?.remote);
  }),
  'strata.pull': write((host) => pull(host)),
  'strata.push': write((host, ctx) =>
    push(host, optionalTarget(ctx, ['branch'], host)?.ref.short ?? host.refs.headBranch),
  ),
  'strata.publish': on(['branch'], (host, t) => publish(host, t.ref.short)),
  'strata.resolveConflicts': async () => {
    const host = panel().flowHost();
    await resolveConflicts(host, await readUnmerged(host.git, host.cwd));
  },
  'strata.showStash': (ctx) => {
    panel().flowHost().reveal(stashHash(ctx));
  },
  'strata.keepStash': (ctx) => panel().flowHost().leftovers.keep(stashHash(ctx)),

  'strata.undo': write(undoLast),
  'strata.showOutput': () => {
    env.runner.showOutput();
  },
});

/** VS Code 1.90 shows the error of a handler that throws as it is; every failure goes through `fail` instead. */
const guarded = (env: FlowEnv, handler: (ctx: MenuArg) => unknown) => async (ctx: MenuArg) => {
  try {
    await handler(ctx);
  } catch (e) {
    await fail(env, e);
  }
};

export function registerCommands(env: FlowEnv): vscode.Disposable[] {
  const all = handlers(env);
  return COMMAND_IDS.map((id) => vscode.commands.registerCommand(id, guarded(env, all[id])));
}
