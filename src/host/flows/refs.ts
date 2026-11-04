import * as vscode from 'vscode';
import { autostashMessage, type StashChoice } from '../../core/autostash.ts';
import { checkedOutPath } from '../../core/git-error.ts';
import type { Operation } from '../../core/operations.ts';
import { refNameProblem } from '../../core/ref-name.ts';
import type { Ref, RefKind } from '../../core/refs.ts';
import { remoteBranch } from '../../core/remote-branch.ts';
import {
  checkedOutElsewhere,
  createBranchInput,
  createTagInput,
  deleteBranchConfirmation,
  deleteTagConfirmation,
  DOING,
  DONE,
  leaveBehindConfirmation,
  migrateConflicted,
  NEEDS_NEW_NAME,
  quote,
  refExists,
  renameInput,
  stashButtons,
  switchConfirmation,
  tagMessageInput,
} from '../../core/wording.ts';
import {
  countCommits,
  readCommit,
  readHead,
  readMergeBase,
  readUnmerged,
  readUnmergedCommits,
  readUpstream,
} from '../../git/facts.ts';
import { GitOpError } from '../../git/op.ts';
import { runGit } from '../../git/run.ts';
import { finish, notify, run, type Expect, type FlowHost, type Undo } from '../flow.ts';
import { changes, resolveConflicts, stashAround, warnRestoreConflict } from './changes.ts';

/** A move of HEAD: checkout of a branch or commit, or creating a branch and switching to it. */
interface SwitchTo {
  /** The target as sentences name it: a quoted branch or a short id. */
  to: string;
  /** The branch HEAD ends on, for git's "checked out elsewhere". */
  branch?: string;
  /** The commit HEAD ends on. */
  commit: string;
  /** The ref named as the target, which must not move before the switch. */
  ref?: Expect;
  op: (migrate: boolean) => Operation;
  done: string;
  undo?: Undo;
}

/** Moves HEAD, minding commits only HEAD reaches and uncommitted changes the target touches. */
async function switchTo(host: FlowHost, s: SwitchTo): Promise<void> {
  const [head, left] = await Promise.all([
    readHead(host.git, host.cwd),
    countCommits(host.git, host.cwd, ['HEAD', '--not', s.commit, '--branches', '--remotes', '--tags']),
  ]);
  const expect: Expect[] = [
    { rev: 'HEAD', hash: head.hash, name: head.branch === undefined ? 'HEAD' : quote(head.branch) },
    ...(s.ref ? [s.ref] : []),
  ];
  if (left > 0) {
    const head = await readCommit(host.git, host.cwd, 'HEAD');
    if (!(await host.ui.confirm(leaveBehindConfirmation(left, head)))) return;
  }
  const c = await changes(host, 'switch', s.commit);
  let choice: StashChoice | undefined;
  if (c.choices.choices.length > 0) {
    choice = await host.ui.confirm(
      switchConfirmation(s.to, c.overlap, c.section, stashButtons('switch', c.choices.choices)),
    );
    if (choice === undefined) return;
  }
  let restored: 'restored' | 'conflicted' | undefined;
  try {
    restored = await run(
      host,
      DOING.switching(s.to),
      (exec) =>
        choice === 'stash'
          ? stashAround(host, exec, autostashMessage('switch', `to ${s.to}`), () => exec(s.op(false)))
          : exec(s.op(choice === 'migrate')).then(() => 'restored' as const),
      { expect },
    );
  } catch (e) {
    if (e instanceof GitOpError && e.kind === 'checkedOutElsewhere' && s.branch !== undefined) {
      notify(host, 'error', checkedOutElsewhere(s.branch, checkedOutPath(e.stderr)), [], () => undefined);
      return;
    }
    throw e;
  }
  if (restored === undefined) return;
  await finish(host, { message: s.done, focus: s.commit, ...(s.undo ? { undo: s.undo } : {}) });
  if (restored === 'conflicted') await warnRestoreConflict(host, s.done);
  else if (choice === 'migrate') {
    // switch --merge exits 0 even when it leaves conflicts.
    const paths = await readUnmerged(host.git, host.cwd);
    if (paths.length > 0)
      notify(host, 'warning', migrateConflicted(s.done, paths.length), ['Resolve...'], () =>
        resolveConflicts(host, paths),
      );
  }
}

export async function checkoutBranch(host: FlowHost, ref: Ref): Promise<void> {
  const tip = await readCommit(host.git, host.cwd, ref.name);
  await switchTo(host, {
    to: quote(ref.short),
    branch: ref.short,
    commit: tip.hash,
    ref: { rev: ref.name, hash: tip.hash, name: quote(ref.short) },
    op: (migrate) => ({ kind: 'switch', branch: ref.short, migrate }),
    done: DONE.switched(ref.short),
  });
}

/** Switches to the local branch of a remote-tracking branch, creating it when there is none. */
export async function checkoutRemote(host: FlowHost, ref: Ref): Promise<void> {
  const rb = remoteBranch(ref.name, host.refs.remotes);
  if (!rb) throw new Error(`'${ref.short}' is not a branch of a known remote.`);
  const local = host.refs.refs.find((r) => r.kind === 'branch' && r.short === rb.branch);
  if (!local) {
    const tip = await readCommit(host.git, host.cwd, ref.name);
    await switchTo(host, {
      to: quote(rb.branch),
      commit: tip.hash,
      ref: { rev: ref.name, hash: tip.hash, name: quote(ref.short) },
      op: (migrate) => ({ kind: 'trackRemote', name: rb.branch, remoteRef: ref.name, migrate }),
      done: DONE.tracking(rb.branch, ref.short),
    });
    return;
  }
  const [tip, behind] = await Promise.all([
    readCommit(host.git, host.cwd, local.name),
    countCommits(host.git, host.cwd, [`${local.name}..${ref.name}`]),
  ]);
  await switchTo(host, {
    to: quote(rb.branch),
    branch: rb.branch,
    commit: tip.hash,
    ref: { rev: local.name, hash: tip.hash, name: quote(rb.branch) },
    op: (migrate) => ({ kind: 'switch', branch: rb.branch, migrate }),
    done: DONE.switched(rb.branch, behind > 0 ? { count: behind, upstream: ref.short } : undefined),
  });
}

/** `rev`: a commit id or a tag. */
export async function checkoutDetached(host: FlowHost, rev: string): Promise<void> {
  const at = await readCommit(host.git, host.cwd, rev);
  await switchTo(host, {
    to: at.short,
    commit: at.hash,
    op: (migrate) => ({ kind: 'detach', commit: at.hash, migrate }),
    done: DONE.detached(at.short),
  });
}

/** Validates a new branch or tag name against git's rules and the names the graph knows. */
const newName =
  (host: FlowHost, kind: Extract<RefKind, 'branch' | 'tag'>) =>
  (name: string): string | undefined => {
    const existing = host.refs.refs.find((r) => r.kind === kind && r.short === name);
    return refNameProblem(name) ?? (existing ? refExists(kind, name, existing.hash.slice(0, 7)) : undefined);
  };

export async function createBranch(host: FlowHost, at: string): Promise<void> {
  const [commit, head] = await Promise.all([readCommit(host.git, host.cwd, at), readHead(host.git, host.cwd)]);
  const prefix = host.settings().branchPrefix;
  const name = await host.ui.input({
    ...createBranchInput(commit),
    value: prefix,
    selectValue: false,
    validate: newName(host, 'branch'),
  });
  if (name === undefined) return;
  const back: Operation =
    head.branch === undefined
      ? { kind: 'detach', commit: head.hash, migrate: false }
      : { kind: 'switch', branch: head.branch, migrate: false };
  await switchTo(host, {
    to: quote(name),
    branch: name,
    commit: commit.hash,
    op: (migrate) => ({ kind: 'createBranch', name, at: commit.hash, migrate }),
    done: DONE.branchCreated(name, commit.short),
    undo: {
      label: 'branch creation',
      ops: [back, { kind: 'deleteBranch', name }],
      guard: { head: commit.hash, back: head.hash },
      focus: head.hash,
    },
  });
}

export async function createTag(host: FlowHost, at: string): Promise<void> {
  const commit = await readCommit(host.git, host.cwd, at);
  const name = await host.ui.input({ ...createTagInput(commit), validate: newName(host, 'tag') });
  if (name === undefined) return;
  const message = await host.ui.input({ ...tagMessageInput(name, commit), validate: () => undefined });
  if (message === undefined) return;
  const ran = await run(host, DOING.creatingTag(name), (exec) =>
    exec({ kind: 'createTag', name, at: commit.hash, message: message === '' ? undefined : message }),
  );
  if (ran === undefined) return;
  await finish(host, {
    message: DONE.tagCreated(name, commit.short),
    focus: commit.hash,
    undo: { label: 'tag creation', ops: [{ kind: 'deleteTag', name }], focus: commit.hash },
  });
}

export async function renameBranch(host: FlowHost, ref: Ref): Promise<void> {
  const [tip, upstream] = await Promise.all([
    readCommit(host.git, host.cwd, ref.name),
    readUpstream(host.git, host.cwd, ref.short),
  ]);
  const valid = newName(host, 'branch');
  const to = await host.ui.input({
    ...renameInput(ref.short, upstream?.remote),
    value: ref.short,
    validate: (name) => (name === ref.short ? NEEDS_NEW_NAME : valid(name)),
  });
  if (to === undefined) return;
  const ran = await run(
    host,
    DOING.renaming(ref.short),
    (exec) => exec({ kind: 'renameBranch', from: ref.short, to }),
    {
      expect: [{ rev: ref.name, hash: tip.hash, name: quote(ref.short) }],
    },
  );
  if (ran === undefined) return;
  await finish(host, {
    message: DONE.renamed(ref.short, to),
    focus: tip.hash,
    undo: { label: 'rename', ops: [{ kind: 'renameBranch', from: to, to: ref.short }], focus: tip.hash },
  });
}

export async function deleteBranch(host: FlowHost, ref: Ref): Promise<void> {
  const [tip, unmerged, upstream] = await Promise.all([
    readCommit(host.git, host.cwd, ref.name),
    readUnmergedCommits(host.git, host.cwd, ref.short),
    readUpstream(host.git, host.cwd, ref.short),
  ]);
  if (!(await host.ui.confirm(deleteBranchConfirmation(ref.short, tip, unmerged, upstream?.name)))) return;
  // Where the branch hung off the current line, which stays in the graph.
  const forkPoint = await readMergeBase(host.git, host.cwd, 'HEAD', tip.hash);
  let ran: string | undefined;
  try {
    ran = await run(host, DOING.deletingBranch(ref.short), (exec) => exec({ kind: 'deleteBranch', name: ref.short }), {
      expect: [{ rev: ref.name, hash: tip.hash, name: quote(ref.short) }],
    });
  } catch (e) {
    if (e instanceof GitOpError && e.kind === 'checkedOutElsewhere') {
      notify(host, 'error', checkedOutElsewhere(ref.short, checkedOutPath(e.stderr)), [], () => undefined);
      return;
    }
    throw e;
  }
  if (ran === undefined) return;
  await finish(host, {
    message: DONE.branchDeleted(ref.short),
    ...(forkPoint === undefined ? {} : { focus: forkPoint }),
    undo: { label: 'branch deletion', ops: [{ kind: 'branchAt', name: ref.short, at: tip.hash }], focus: tip.hash },
  });
}

export async function deleteTag(host: FlowHost, ref: Ref): Promise<void> {
  const [object, at] = await Promise.all([
    // The tag object of an annotated tag, so Undo restores its message too.
    runGit(host.git, host.cwd, ['rev-parse', '--verify', ref.name]).then((s) => s.trim()),
    readCommit(host.git, host.cwd, ref.name),
  ]);
  if (!(await host.ui.confirm(deleteTagConfirmation(ref.short, at)))) return;
  const ran = await run(host, DOING.deletingTag(ref.short), (exec) => exec({ kind: 'deleteTag', name: ref.short }), {
    expect: [{ rev: ref.name, hash: object, name: quote(ref.short) }],
  });
  if (ran === undefined) return;
  await finish(host, {
    message: DONE.tagDeleted(ref.short),
    focus: at.hash,
    undo: {
      label: 'tag deletion',
      ops: [{ kind: 'createTag', name: ref.short, at: object, message: undefined }],
      focus: at.hash,
    },
  });
}

export async function copyRefName(host: FlowHost, ref: Ref): Promise<void> {
  await vscode.env.clipboard.writeText(ref.short);
  host.done(DONE.copied(ref.short));
}
