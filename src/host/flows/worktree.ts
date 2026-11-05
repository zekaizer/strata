import { DOING, DONE, removeWorktreeConfirmation } from '../../core/wording.ts';
import type { WorktreeInfo } from '../../core/worktrees.ts';
import { runGit } from '../../git/run.ts';
import { finish, run, type FlowHost } from '../flow.ts';

/** Removes another worktree and its folder, after saying what is lost with it. */
export async function removeWorktree(host: FlowHost, w: WorktreeInfo): Promise<void> {
  if (w.main) throw new Error('The main worktree cannot be removed.');
  // One line per changed path; a rename is one line. Read without taking that worktree's index lock.
  const status = await runGit(host.git, w.path, ['--no-optional-locks', 'status', '--porcelain']);
  const changes = status.split('\n').filter(Boolean).length;
  const locked = w.state.kind === 'locked' ? (w.state.reason ?? '') : undefined;
  const branch = w.branch?.replace(/^refs\/heads\//, '');
  if (!(await host.ui.confirm(removeWorktreeConfirmation({ name: w.name, path: w.path, branch, changes, locked }))))
    return;
  const force = locked !== undefined ? 2 : changes > 0 ? 1 : 0;
  const ran = await run(host, DOING.removingWorktree(w.name), (exec) =>
    exec({ kind: 'removeWorktree', path: w.path, force }),
  );
  if (ran === undefined) return;
  await finish(host, { message: DONE.worktreeRemoved(w.name), quiet: true });
}

/** Forgets the worktrees whose folders are gone (`git worktree prune`). */
export async function pruneWorktrees(host: FlowHost): Promise<void> {
  const gone = host.refs.worktrees.filter((w) => w.state.kind === 'prunable').map((w) => w.name);
  const ran = await run(host, DOING.pruningWorktrees, (exec) => exec({ kind: 'pruneWorktrees' }));
  if (ran === undefined) return;
  await finish(host, { message: DONE.worktreesPruned(gone), quiet: true });
}
