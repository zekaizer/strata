import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { atLeast, HOOK_RUN, type GitVersion } from '../core/git-version.ts';
import { LINE_LIMIT, type LineCommit } from '../core/rewrite.ts';
import { gitEnv } from './env.ts';
import { GitOpError, runGitOp } from './op.ts';
import { runGit } from './run.ts';

const FIELDS = 7;

/**
 * HEAD's first-parent line, newest first, down to commit `oldest` (full id; undefined: the root),
 * or `limit` commits when `oldest` is not on it within that.
 */
export async function readLine(
  git: string,
  cwd: string,
  oldest: string | undefined,
  limit = LINE_LIMIT,
): Promise<LineCommit[]> {
  const out = await runGit(git, cwd, [
    'log',
    '--first-parent',
    '--no-show-signature',
    '-z',
    '--date=raw',
    `--max-count=${limit}`,
    '--format=%H%x00%P%x00%T%x00%an%x00%ae%x00%ad%x00%B',
    'HEAD',
    ...(oldest === undefined ? [] : ['--not', `${oldest}^@`]),
    '--',
  ]);
  const f = out.split('\0');
  const line: LineCommit[] = [];
  for (let i = 0; i + FIELDS <= f.length; i += FIELDS) {
    const [hash = '', parents = '', tree = '', name = '', email = '', date = '', message = ''] = f.slice(i, i + FIELDS);
    line.push({
      hash: hash.replace(/^\n/, ''),
      parents: parents.split(' ').filter((p) => p !== ''),
      tree,
      author: { name, email, date },
      message,
    });
  }
  return line;
}

/** Of the commits after `base` (undefined: all) up to HEAD, those no remote-tracking branch has. */
export async function readUnpushed(git: string, cwd: string, base: string | undefined): Promise<Set<string>> {
  const out = await runGit(git, cwd, [
    'rev-list',
    'HEAD',
    ...(base === undefined ? [] : [`^${base}`]),
    '--not',
    '--remotes',
    '--',
  ]);
  return new Set(out.split('\n').filter((h) => h !== ''));
}

/** The first of `upstream` (preferred) and the remote-tracking branches that has `commit`, by short name. */
export async function readRemoteHaving(
  git: string,
  cwd: string,
  commit: string,
  upstream: string | undefined,
): Promise<string | undefined> {
  const out = await runGit(git, cwd, [
    'for-each-ref',
    `--contains=${commit}`,
    '--format=%(refname)%00%(refname:short)',
    'refs/remotes',
  ]);
  const found = out
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => l.split('\0') as [string, string]);
  return (found.find(([full]) => full === upstream) ?? found[0])?.[1];
}

/** A local branch or tag that has a commit, and the commit it points at (a tag peeled). */
export interface RefHaving {
  name: string;
  short: string;
  kind: 'branch' | 'tag';
  hash: string;
}

/** Local branches and tags that have commit `oldest`: at it, at a newer one, or branched off after it. */
export async function readRefsHaving(git: string, cwd: string, oldest: string): Promise<RefHaving[]> {
  const out = await runGit(git, cwd, [
    'for-each-ref',
    `--contains=${oldest}`,
    '--format=%(refname)%00%(refname:short)%00%(objectname)%00%(*objectname)',
    'refs/heads',
    'refs/tags',
  ]);
  return out
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      const [name = '', short = '', object = '', peeled = ''] = l.split('\0');
      return { name, short, kind: name.startsWith('refs/tags/') ? 'tag' : 'branch', hash: peeled || object };
    });
}

const gitPath = async (git: string, cwd: string, path: string) =>
  resolve(cwd, (await runGit(git, cwd, ['rev-parse', '--git-path', path])).trim());

/** Writes the todo of a rebase Strata runs into the git dir; resolves its path. */
export async function writeTodo(git: string, cwd: string, todo: string): Promise<string> {
  const path = await gitPath(git, cwd, 'strata-rebase-todo');
  await writeFile(path, todo);
  return path;
}

/** The commit-msg hook refused a message; its output says why. */
export class HookRefused extends Error {}

/**
 * Runs the repository's commit-msg hook, if it has one, on `message` as `git commit` would
 * (Gerrit's adds a Change-Id); resolves the message the hook left. Rejects with HookRefused.
 */
export async function runCommitMsgHook(
  git: string,
  cwd: string,
  version: GitVersion | undefined,
  message: string,
): Promise<string> {
  const file = await gitPath(git, cwd, 'STRATA_EDITMSG');
  await writeFile(file, message);
  if (version === undefined || atLeast(version, HOOK_RUN)) {
    try {
      await runGitOp(git, cwd, ['hook', 'run', '--ignore-missing', 'commit-msg', '--', file]);
    } catch (e) {
      if (e instanceof GitOpError) throw new HookRefused(hookOutput(e.stdout, e.stderr));
      throw e;
    }
  } else {
    // core.hooksPath applies to --git-path hooks.
    const hook = await gitPath(git, cwd, 'hooks/commit-msg');
    const runnable = await access(hook, constants.X_OK).then(
      () => true,
      () => false,
    );
    if (runnable) await runHook(hook, cwd, file);
  }
  return readFile(file, 'utf8');
}

const hookOutput = (stdout: string, stderr: string) =>
  [stdout.trim(), stderr.trim()].filter((s) => s !== '').join('\n') || 'the commit-msg hook failed';

function runHook(hook: string, cwd: string, file: string): Promise<void> {
  return new Promise((done, reject) => {
    const proc = spawn(hook, [file], { cwd, env: { ...gitEnv(), GIT_EDITOR: ':' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    proc.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) done();
      else reject(new HookRefused(hookOutput(stdout, stderr)));
    });
  });
}
