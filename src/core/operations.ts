import type { OperationKind } from './repo-state.ts';

/** Reset modes, in increasing order of what they throw away. */
export type ResetMode = 'soft' | 'mixed' | 'keep' | 'hard';

/** How a merge records the result. */
export type MergeMode = 'auto' | 'noFastForward';

/**
 * Every repository change Strata makes. Ids are validated commit ids, names pass refNameProblem,
 * and refs are full names that exist; argv() trusts that.
 */
export type Operation =
  | { kind: 'switch'; branch: string; migrate: boolean }
  | { kind: 'detach'; commit: string; migrate: boolean }
  | { kind: 'createBranch'; name: string; at: string; migrate: boolean }
  | { kind: 'trackRemote'; name: string; remoteRef: string; migrate: boolean }
  /** A branch at `at` without switching to it (Undo of a deletion). */
  | { kind: 'branchAt'; name: string; at: string }
  | { kind: 'createTag'; name: string; at: string; message: string | undefined }
  | { kind: 'renameBranch'; from: string; to: string }
  | { kind: 'deleteBranch'; name: string }
  | { kind: 'deleteTag'; name: string }
  /** `ref` as the merge commit's message should name it: a short ref name or a commit id. */
  | { kind: 'merge'; ref: string; mode: MergeMode; autostash: boolean }
  | { kind: 'rebase'; onto: string; autostash: boolean }
  | { kind: 'cherryPick'; commit: string }
  | { kind: 'revert'; commit: string }
  | { kind: 'reset'; commit: string; mode: ResetMode }
  | { kind: 'continue' | 'abort' | 'skip'; operation: OperationKind }
  | { kind: 'stashPush'; message: string | undefined; includeUntracked: boolean }
  | { kind: 'stashApply' | 'stashPop' | 'stashDrop'; index: number }
  | { kind: 'stashBranch'; name: string; index: number }
  | { kind: 'stashStore'; commit: string; message: string }
  | { kind: 'fetch'; remote: string | undefined }
  | { kind: 'pull'; rebase: boolean; autostash: boolean }
  | { kind: 'push'; branch: string; remote: string; setUpstream: boolean; forceWithLease: string | undefined };

const GIT_COMMAND: Record<OperationKind, string> = {
  rebase: 'rebase',
  merge: 'merge',
  cherryPick: 'cherry-pick',
  revert: 'revert',
};

const stash = (index: number) => `stash@{${index}}`;
const merge = (migrate: boolean) => (migrate ? ['--merge'] : []);
const autostash = (on: boolean) => [on ? '--autostash' : '--no-autostash'];

/** The git arguments of an operation (git >= 2.27). */
export function argv(op: Operation): string[] {
  switch (op.kind) {
    case 'switch':
      return ['switch', '--no-guess', ...merge(op.migrate), op.branch];
    case 'detach':
      return ['switch', '--detach', ...merge(op.migrate), op.commit];
    case 'createBranch':
      return ['switch', ...merge(op.migrate), '--create', op.name, op.at];
    case 'trackRemote':
      return ['switch', ...merge(op.migrate), '--create', op.name, '--track', op.remoteRef];
    case 'branchAt':
      return ['branch', op.name, op.at];
    case 'createTag':
      return op.message === undefined
        ? ['tag', op.name, op.at]
        : ['tag', '--annotate', '--message', op.message, op.name, op.at];
    case 'renameBranch':
      return ['branch', '--move', op.from, op.to];
    case 'deleteBranch':
      // Strata confirms with the exact commits that become unreachable; -d's merged check is narrower.
      return ['branch', '--delete', '--force', op.name];
    case 'deleteTag':
      return ['tag', '--delete', op.name];
    case 'merge':
      return [
        'merge',
        '--no-edit',
        ...(op.mode === 'noFastForward' ? ['--no-ff'] : []),
        ...autostash(op.autostash),
        op.ref,
      ];
    case 'rebase':
      return ['rebase', ...autostash(op.autostash), op.onto];
    case 'cherryPick':
      return ['cherry-pick', op.commit];
    case 'revert':
      return ['revert', '--no-edit', op.commit];
    case 'reset':
      return ['reset', `--${op.mode}`, op.commit];
    case 'continue':
      // For a merge, `commit --no-edit` would keep the "# Conflicts:" notes; --continue's editor (none) strips them.
      return [GIT_COMMAND[op.operation], '--continue'];
    case 'abort':
      return [GIT_COMMAND[op.operation], '--abort'];
    case 'skip':
      if (op.operation === 'merge') throw new Error('a merge cannot skip');
      return [GIT_COMMAND[op.operation], '--skip'];
    case 'stashPush':
      return [
        'stash',
        'push',
        ...(op.includeUntracked ? ['--include-untracked'] : []),
        ...(op.message === undefined ? [] : ['--message', op.message]),
      ];
    case 'stashApply':
      return ['stash', 'apply', stash(op.index)];
    case 'stashPop':
      return ['stash', 'pop', stash(op.index)];
    case 'stashDrop':
      return ['stash', 'drop', stash(op.index)];
    case 'stashBranch':
      return ['stash', 'branch', op.name, stash(op.index)];
    case 'stashStore':
      return ['stash', 'store', '--message', op.message, op.commit];
    case 'fetch':
      return ['fetch', '--progress', ...(op.remote === undefined ? ['--all'] : [op.remote])];
    case 'pull':
      return ['pull', '--progress', op.rebase ? '--rebase' : '--no-rebase', ...autostash(op.autostash)];
    case 'push':
      return [
        'push',
        '--progress',
        ...(op.setUpstream ? ['--set-upstream'] : []),
        ...(op.forceWithLease === undefined ? [] : [`--force-with-lease=refs/heads/${op.branch}:${op.forceWithLease}`]),
        op.remote,
        `refs/heads/${op.branch}:refs/heads/${op.branch}`,
      ];
  }
}
