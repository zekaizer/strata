import * as vscode from 'vscode';
import type { FileChange, FileStatus, FileView } from '../core/details.ts';
import { canWrite, parseGitVersion, type GitVersion } from '../core/git-version.ts';
import { gitTooOld } from '../core/wording.ts';
import { isCommitId } from '../git/details.ts';
import { runGit } from '../git/run.ts';
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
  renameBranch,
} from './flows/refs.ts';
import { GraphPanel } from './panel.ts';
import { parseTarget, StaleTarget, type TargetKind, type TargetOf } from './target.ts';

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

const copy = (text: (ctx: MenuArg) => string | Promise<string>) => async (ctx: MenuArg) => {
  await vscode.env.clipboard.writeText(await text(ctx));
};

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
 * A command that changes the repository. Failures are shown, not thrown; a menu on a ref that is
 * gone also refreshes the graph, and rejects like any invalid argument.
 */
const write = (flow: (host: FlowHost, ctx: MenuArg) => Promise<void>) => async (ctx: MenuArg) => {
  const host = panel().flowHost();
  if (!(await gitCanWrite(host))) return;
  try {
    await flow(host, ctx);
  } catch (e) {
    if (e instanceof StaleTarget) {
      void host.ui.notify('error', e.message);
      await host.refresh();
      throw e;
    }
    await fail(host, e);
  }
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
  'strata.file.copyRelativePath': copy((ctx) => fileArg(ctx).file.path),
  'strata.file.copyPath': copy((ctx) => panel().absolutePath(fileArg(ctx).file.path)),
  'strata.file.copyOldRelativePath': copy((ctx) => {
    const { file } = fileArg(ctx);
    if (file.oldPath === undefined) throw new Error('not a rename');
    return file.oldPath;
  }),
  'strata.file.copyPatch': (ctx) => {
    const { hash, base, file } = fileArg(ctx);
    return panel().copyFilePatch(hash, base, file);
  },
  'strata.commit.copyHash': copy((ctx) => commitArg(ctx).hash),
  'strata.commit.copyShortHash': copy((ctx) => panel().shortHash(commitArg(ctx).hash)),
  'strata.commit.copySubject': copy((ctx) => commitArg(ctx).subject),
  'strata.commit.copyPatch': (ctx) => panel().copyCommitPatch(commitArg(ctx).hash),

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

  'strata.undo': write(undoLast),
  'strata.showOutput': () => {
    env.runner.showOutput();
  },
});

export function registerCommands(env: FlowEnv): vscode.Disposable[] {
  const all = handlers(env);
  return COMMAND_IDS.map((id) => vscode.commands.registerCommand(id, all[id]));
}
