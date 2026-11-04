import * as vscode from 'vscode';
import type { FileChange, FileStatus, FileView } from '../core/details.ts';
import { isCommitId } from '../git/details.ts';
import { MENU_COMMANDS, type MenuCommand } from '../shared/menu-commands.ts';
import { isRepoPath } from './controller.ts';
import { GraphPanel } from './panel.ts';

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

const HANDLERS: Record<MenuCommand, (ctx: MenuArg) => unknown> = {
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
};

export function registerMenuCommands(): vscode.Disposable[] {
  return MENU_COMMANDS.map((id) => vscode.commands.registerCommand(id, HANDLERS[id]));
}
