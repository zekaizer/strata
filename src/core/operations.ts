import type { OperationKind } from './repo-state.ts';

/** Reset modes, in increasing order of what they throw away. */
export type ResetMode = 'soft' | 'mixed' | 'keep' | 'hard';

/** How a merge records the result: fast-forward when it can, or always a merge commit. */
export type MergeMode = 'ff' | 'noFastForward';

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
  /** Tag `name` on `object`, a tag object or a commit, failing when the tag exists (Undo of a deletion). */
  | { kind: 'restoreTag'; name: string; object: string }
  | { kind: 'renameBranch'; from: string; to: string }
  /** Adds a config value (Undo of a deletion puts back the branch's configuration). */
  | { kind: 'configAdd'; key: string; value: string }
  | { kind: 'deleteBranch'; name: string }
  | { kind: 'unsetUpstream'; branch: string }
  | { kind: 'deleteTag'; name: string }
  /** `ref`: a commit id, or a ref name that git reads as the ref meant (the merge message names it). */
  | { kind: 'merge'; ref: string; mode: MergeMode; autostash: boolean }
  /**
   * `onto`: the commit id the confirmation named. `from`: replay only the commits after it (where
   * the branch forked from a rewritten upstream), not every commit `onto` lacks.
   */
  | { kind: 'rebase'; onto: string; from: string | undefined; autostash: boolean }
  /** `mainline`: for a merge commit, the parent (1-based) its changes are taken relative to. */
  | { kind: 'cherryPick' | 'revert'; commit: string; mainline?: number }
  | { kind: 'reset'; commit: string; mode: ResetMode }
  | { kind: 'continue' | 'abort' | 'skip'; operation: OperationKind }
  /**
   * `untracked`: untracked files stashed too, none, those git does not ignore, or ignored ones as
   * well. `paths`: only these (a safety stash of exactly what an operation would overwrite).
   */
  | {
      kind: 'stashPush';
      message: string | undefined;
      untracked: 'none' | 'unignored' | 'all';
      paths?: readonly string[];
    }
  | { kind: 'stashApply' | 'stashPop' | 'stashDrop'; index: number }
  | { kind: 'stashBranch'; name: string; index: number }
  | { kind: 'stashStore'; commit: string; message: string }
  /**
   * `unshallow`: the whole history of a shallow clone; `deepen`: that many more commits of it;
   * `ref`: only this ref of `remote`.
   */
  | { kind: 'fetch'; remote: string | undefined; unshallow?: boolean; deepen?: number; ref?: string }
  /**
   * Local `branch` to `dest`, a full ref on `remote` (the upstream's branch may have another name).
   * `forceWithLease`: the commit `dest` must still be at.
   */
  | {
      kind: 'push';
      branch: string;
      remote: string;
      dest: string;
      setUpstream: boolean;
      forceWithLease: string | undefined;
    }
  | { kind: 'pushTag'; remote: string; tag: string }
  /** Deletes full ref `ref` on `remote`. `lease`: the commit it must still be at there. */
  | { kind: 'deleteRemoteRef'; remote: string; ref: string; lease: string | undefined };

/** How many commits further back Fetch More History reaches in a shallow clone. */
export const MORE_HISTORY = 100;

const GIT_COMMAND: Record<OperationKind, string> = {
  rebase: 'rebase',
  merge: 'merge',
  cherryPick: 'cherry-pick',
  revert: 'revert',
};

const stash = (index: number) => `stash@{${index}}`;
const merge = (migrate: boolean) => (migrate ? ['--merge'] : []);
const mainline = (parent: number | undefined) => (parent === undefined ? [] : ['--mainline', String(parent)]);
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
      // tag.gpgSign makes every tag a signed annotated one, and an empty message fails it.
      return op.message === undefined
        ? ['-c', 'tag.gpgSign=false', 'tag', op.name, op.at]
        : ['tag', '--annotate', '--message', op.message, op.name, op.at];
    case 'restoreTag':
      // `git tag` would make a new tag of a tag object; the empty old value fails when the tag exists.
      return ['update-ref', `refs/tags/${op.name}`, op.object, ''];
    case 'renameBranch':
      return ['branch', '--move', op.from, op.to];
    case 'configAdd':
      return ['config', '--add', op.key, op.value];
    case 'deleteBranch':
      // Strata confirms with the exact commits that become unreachable; -d's merged check is narrower.
      return ['branch', '--delete', '--force', op.name];
    case 'unsetUpstream':
      return ['branch', '--unset-upstream', op.branch];
    case 'deleteTag':
      return ['tag', '--delete', op.name];
    case 'merge':
      // Explicit, so merge.ff and branch.<b>.mergeOptions (--squash, --no-commit) never contradict the button.
      return [
        'merge',
        '--no-edit',
        '--commit',
        '--no-squash',
        op.mode === 'noFastForward' ? '--no-ff' : '--ff',
        ...autostash(op.autostash),
        op.ref,
      ];
    case 'rebase':
      // The confirmation names what a plain rebase does: no other branch moves, merges are dropped
      // (their commits replayed one by one), and no fixup! commits are reordered. Unknown keys are ignored.
      return [
        ...['-c', 'rebase.updateRefs=false', '-c', 'rebase.rebaseMerges=false', '-c', 'rebase.autoSquash=false'],
        'rebase',
        ...autostash(op.autostash),
        ...(op.from === undefined ? [op.onto] : ['--onto', op.onto, op.from]),
      ];
    case 'cherryPick':
      return ['cherry-pick', ...mainline(op.mainline), op.commit];
    case 'revert':
      return ['revert', '--no-edit', ...mainline(op.mainline), op.commit];
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
        ...({ none: [], unignored: ['--include-untracked'], all: ['--all'] } as const)[op.untracked],
        ...(op.message === undefined ? [] : ['--message', op.message]),
        ...(op.paths === undefined ? [] : ['--', ...op.paths.map((p) => `:(literal)${p}`)]),
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
      if (op.unshallow) return ['fetch', '--progress', '--unshallow', ...(op.remote === undefined ? [] : [op.remote])];
      if (op.deepen !== undefined)
        return ['fetch', '--progress', `--deepen=${op.deepen}`, ...(op.remote === undefined ? [] : [op.remote])];
      if (op.remote !== undefined && op.ref !== undefined) return ['fetch', '--progress', op.remote, op.ref];
      return ['fetch', '--progress', ...(op.remote === undefined ? ['--all'] : [op.remote])];
    case 'push':
      return [
        'push',
        '--progress',
        ...(op.setUpstream ? ['--set-upstream'] : []),
        ...(op.forceWithLease === undefined ? [] : [`--force-with-lease=${op.dest}:${op.forceWithLease}`]),
        op.remote,
        `refs/heads/${op.branch}:${op.dest}`,
      ];
    case 'pushTag':
      return ['push', '--progress', op.remote, `refs/tags/${op.tag}`];
    case 'deleteRemoteRef':
      return [
        'push',
        '--progress',
        ...(op.lease === undefined ? [] : [`--force-with-lease=${op.ref}:${op.lease}`]),
        '--delete',
        op.remote,
        op.ref,
      ];
  }
}
