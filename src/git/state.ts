import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  CONFLICTS_SHOWN,
  parseStatus,
  type OperationKind,
  type OperationState,
  type Worktree,
} from '../core/repo-state.ts';
import { runGit } from './run.ts';

/** Files git keeps while an operation is stopped; --git-path finds them in linked worktrees too. */
const MARKERS = [
  'rebase-merge',
  'rebase-apply',
  'REBASE_HEAD',
  'MERGE_HEAD',
  'MERGE_AUTOSTASH',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
] as const;

const text = (path: string) =>
  readFile(path, 'utf8').then(
    (s) => s.trim(),
    () => undefined,
  );
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const firstLine = (s: string | undefined) => s?.split('\n')[0];

/** The operation in progress, if any. */
export async function readOperationState(git: string, cwd: string): Promise<OperationState | undefined> {
  const out = await runGit(git, cwd, ['rev-parse', ...MARKERS.flatMap((m) => ['--git-path', m])]);
  const lines = out.split('\n');
  const at = Object.fromEntries(MARKERS.map((m, i) => [m, resolve(cwd, lines[i]!)])) as Record<
    (typeof MARKERS)[number],
    string
  >;

  let kind: OperationKind | undefined;
  let state: Pick<OperationState, 'branch' | 'onto' | 'step' | 'applying' | 'autostash'> | undefined;
  // rebase-apply is also used by `git am`, which Strata does not run; `applying` marks that case.
  const rebaseDir = (await exists(at['rebase-merge']))
    ? at['rebase-merge']
    : (await exists(at['rebase-apply'])) && !(await exists(resolve(at['rebase-apply'], 'applying')))
      ? at['rebase-apply']
      : undefined;
  if (rebaseDir) {
    const merge = rebaseDir === at['rebase-merge'];
    const [head, onto, current, total, rebaseHead, autostash] = await Promise.all([
      text(resolve(rebaseDir, 'head-name')),
      text(resolve(rebaseDir, 'onto')),
      text(resolve(rebaseDir, merge ? 'msgnum' : 'next')),
      text(resolve(rebaseDir, merge ? 'end' : 'last')),
      text(at['REBASE_HEAD']),
      exists(resolve(rebaseDir, 'autostash')),
    ]);
    kind = 'rebase';
    state = {
      branch: head?.startsWith('refs/heads/') ? head.slice('refs/heads/'.length) : undefined,
      onto,
      step: current && total ? { current: Number(current), total: Number(total) } : undefined,
      applying: rebaseHead,
      autostash,
    };
  } else {
    const [mergeHead, pick, revert, mergeAutostash] = await Promise.all([
      text(at['MERGE_HEAD']),
      text(at['CHERRY_PICK_HEAD']),
      text(at['REVERT_HEAD']),
      exists(at['MERGE_AUTOSTASH']),
    ]);
    const found: [OperationKind, string | undefined][] = [
      ['merge', firstLine(mergeHead)],
      ['cherryPick', pick],
      ['revert', revert],
    ];
    const hit = found.find(([, h]) => h !== undefined);
    if (!hit) return undefined;
    kind = hit[0];
    const branch = await runGit(git, cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).then(
      (b) => b.trim(),
      () => undefined,
    );
    state = {
      branch,
      onto: undefined,
      step: undefined,
      applying: hit[1],
      autostash: kind === 'merge' && mergeAutostash,
    };
  }
  const conflicts = (await runGit(git, cwd, ['diff', '--name-only', '-z', '--diff-filter=U', '--']))
    .split('\0')
    .filter((p) => p !== '');
  return { kind, ...state, conflicts: conflicts.slice(0, CONFLICTS_SHOWN), conflictCount: conflicts.length };
}

/** Uncommitted changes to tracked files. Untracked files are not scanned: slow on huge trees, and autostash ignores them. */
export async function readWorktree(git: string, cwd: string): Promise<Worktree> {
  return parseStatus(
    await runGit(git, cwd, ['status', '--porcelain=v2', '-z', '--untracked-files=no', '--ignore-submodules=none']),
  );
}
