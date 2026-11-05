import type { Operation } from '../../core/operations.ts';
import type { Ref } from '../../core/refs.ts';
import { remoteBranch } from '../../core/remote-branch.ts';
import {
  deleteRemoteBranchConfirmation,
  deleteRemoteTagConfirmation,
  deleteRemoteTagPick,
  detachedNoBranch,
  divergedConfirmation,
  forcePushConfirmation,
  NO_REMOTE,
  noUpstream,
  publishPick,
  pushTagPick,
  PULL_NOTES,
  pushOtherNameConfirmation,
  pushRejectedConfirmation,
  quote,
  REMOTE_DOING,
  REMOTE_DONE,
  tagExistsOnRemote,
} from '../../core/wording.ts';
import {
  countCommits,
  readCommit,
  readConfig,
  readForkPoint,
  readHead,
  readTrackingBranches,
  readUnmergedRemoteCommits,
  readUpstream,
} from '../../git/facts.ts';
import { GitOpError } from '../../git/op.ts';
import { runGit } from '../../git/run.ts';
import { fail, finish, notify, run, type Expect, type FlowHost } from '../flow.ts';
import { merge, rebase, refSource, type Source } from './history.ts';

/** Runs a remote operation; a failed sign-in becomes the Run in Terminal question. Resolves whether it ran. */
async function remoteRun(
  host: FlowHost,
  label: string,
  remote: string | undefined,
  op: Operation,
  expect?: readonly Expect[],
): Promise<boolean> {
  try {
    return (await run(host, label, (exec) => exec(op), { remote: true, ...(expect ? { expect } : {}) })) !== undefined;
  } catch (e) {
    if (e instanceof GitOpError && (e.kind === 'auth' || e.kind === 'hostKey')) {
      await fail(host, e, { name: remote, op, cwd: host.cwd });
      return false;
    }
    throw e;
  }
}

function hasRemote(host: FlowHost): boolean {
  if (host.refs.remotes.length > 0) return true;
  void host.ui.notify('error', NO_REMOTE);
  return false;
}

/** `remote`: one remote (a remote branch's), or undefined for all. */
export async function fetchRemote(host: FlowHost, remote: string | undefined): Promise<void> {
  if (!hasRemote(host)) return;
  if (await remoteRun(host, REMOTE_DOING.fetching(remote), remote, { kind: 'fetch', remote }))
    await finish(host, { message: REMOTE_DONE.fetched(remote) });
}

const BOOL: Record<string, boolean> = {
  true: true,
  yes: true,
  on: true,
  '1': true,
  false: false,
  no: false,
  off: false,
  '0': false,
};

/** Fetches the upstream of the current branch, then fast-forwards, merges or rebases onto it. */
export async function pull(host: FlowHost): Promise<void> {
  const h = await readHead(host.git, host.cwd);
  if (h.branch === undefined) {
    void host.ui.notify('info', detachedNoBranch('pull'));
    return;
  }
  const branch = h.branch;
  const upstream = await readUpstream(host.git, host.cwd, branch);
  if (!upstream) {
    notify(host, 'info', noUpstream(branch), ['Publish Branch...'], () => publish(host, branch));
    return;
  }
  const fetch: Operation = { kind: 'fetch', remote: upstream.remote, ref: `refs/heads/${upstream.remoteBranch}` };
  if (!(await remoteRun(host, REMOTE_DOING.fetching(upstream.remote), upstream.remote, fetch))) return;
  const tracking = upstream.ref ?? (await fetched(host));
  const [ahead, behind] = await Promise.all([
    countCommits(host.git, host.cwd, [`${tracking}..HEAD`]),
    countCommits(host.git, host.cwd, [`HEAD..${tracking}`]),
  ]);
  if (behind === 0) {
    await host.refresh();
    host.done(REMOTE_DONE.upToDate);
    return;
  }
  const src: Source = upstream.ref
    ? await refSource(host, { name: upstream.ref, short: upstream.name })
    : { rev: tracking, arg: tracking, name: quote(upstream.name) };
  if (ahead === 0) return merge(host, src, 'whenDirty');
  const [rebaseCfg, ff] = await Promise.all([
    readConfig(host.git, host.cwd, `branch.${branch}.rebase`).then(
      async (v) => v ?? (await readConfig(host.git, host.cwd, 'pull.rebase')),
    ),
    readConfig(host.git, host.cwd, 'pull.ff'),
  ]);
  const rebaseFirst = rebaseCfg === undefined ? undefined : BOOL[rebaseCfg.toLowerCase()];
  const canMerge = ff !== 'only';
  // As git pull --rebase: commits upstream had before a force push are not the branch's own.
  const rebaseOnto = async () => rebase(host, src, 'whenDirty', await readForkPoint(host.git, host.cwd, tracking));
  if (rebaseFirst === true) return rebaseOnto();
  if (rebaseFirst === false && canMerge) return merge(host, src, 'whenDirty');
  // Unset, "merges" or "interactive": ask, saying what Strata can do.
  const note = !canMerge ? PULL_NOTES.ffOnly : rebaseCfg?.startsWith('m') ? PULL_NOTES.rebaseMerges : undefined;
  const answer = await host.ui.confirm(
    divergedConfirmation(quote(branch), upstream.name, ahead, behind, { rebase: true, merge: canMerge }, note),
  );
  if (answer === 'rebase') await rebaseOnto();
  else if (answer === 'merge') await merge(host, src, 'whenDirty');
}

/** Pushes `branch` to its upstream (or where push.default and pushRemote say), or publishes it. */
export async function push(host: FlowHost, branch: string | undefined): Promise<void> {
  if (branch === undefined) {
    void host.ui.notify('info', detachedNoBranch('push'));
    return;
  }
  const upstream = await readUpstream(host.git, host.cwd, branch);
  if (!upstream) return publish(host, branch);
  const [pushRemote, pushDefault, local] = await Promise.all([
    readConfig(host.git, host.cwd, `branch.${branch}.pushRemote`).then(
      async (v) => v ?? (await readConfig(host.git, host.cwd, 'remote.pushDefault')),
    ),
    readConfig(host.git, host.cwd, 'push.default'),
    readCommit(host.git, host.cwd, `refs/heads/${branch}`),
  ]);
  const remote = pushRemote ?? upstream.remote;
  let destBranch = branch;
  if (remote === upstream.remote && upstream.remoteBranch !== branch) {
    if (pushDefault === 'upstream' || pushDefault === 'tracking') destBranch = upstream.remoteBranch;
    else {
      // git's default (simple) would refuse; ask instead of updating a branch of another name.
      const answer = await host.ui.confirm(pushOtherNameConfirmation(branch, remote, upstream.remoteBranch));
      if (answer === undefined) return;
      if (answer === 'upstream') destBranch = upstream.remoteBranch;
    }
  }
  const dest = `refs/heads/${destBranch}`;
  const destName =
    remote === upstream.remote && destBranch === upstream.remoteBranch ? upstream.name : `${remote}/${destBranch}`;
  const op: Operation = { kind: 'push', branch, remote, dest, setUpstream: false, forceWithLease: undefined };
  try {
    if (!(await remoteRun(host, REMOTE_DOING.pushing(branch, destName), remote, op))) return;
  } catch (e) {
    if (e instanceof GitOpError && e.kind === 'rejected') return rejected(host, op, destName, local.hash);
    throw e;
  }
  await finish(host, { message: REMOTE_DONE.pushed(branch, destName) });
}

/** The commit the fetch just run got: a remote-tracking branch may not exist (a URL remote, a narrow refspec). */
async function fetched(host: FlowHost): Promise<string> {
  const hash = await runGit(host.git, host.cwd, ['rev-parse', '--verify', '--quiet', 'FETCH_HEAD^{commit}']).then(
    (s) => s.trim(),
    () => undefined,
  );
  if (!hash) throw new Error('git did not fetch the branch; see the output.');
  return hash;
}

/**
 * A push rejected because the remote has commits the branch lacks: fetch that one ref, so the
 * count, the names and the lease are the remote's, not a stale tracking ref's.
 */
async function rejected(
  host: FlowHost,
  op: Extract<Operation, { kind: 'push' }>,
  destName: string,
  local: string,
): Promise<void> {
  const fetch: Operation = { kind: 'fetch', remote: op.remote, ref: op.dest };
  if (!(await remoteRun(host, REMOTE_DOING.fetching(op.remote), op.remote, fetch))) return;
  const theirs = await fetched(host);
  const [count, newest, h] = await Promise.all([
    countCommits(host.git, host.cwd, [`${local}..${theirs}`]),
    readCommit(host.git, host.cwd, theirs),
    readHead(host.git, host.cwd),
  ]);
  const answer = await host.ui.confirm(
    pushRejectedConfirmation(destName, op.branch, count, h.branch === op.branch, host.settings().allowForcePush),
  );
  if (answer === 'pull') return pull(host);
  if (answer !== 'force') return;
  if (!(await host.ui.confirm(forcePushConfirmation(op.branch, op.remote, destName, count, newest.subject)))) return;
  const force = { ...op, forceWithLease: theirs };
  if (await remoteRun(host, REMOTE_DOING.pushing(op.branch, destName), op.remote, force))
    await finish(host, { message: REMOTE_DONE.forcePushed(op.branch, destName) });
}

/** The remote to push to: the only one, or the user's choice with remote.pushDefault (or origin) first. */
async function pickRemote(host: FlowHost, title: string): Promise<string | undefined> {
  if (!hasRemote(host)) return undefined;
  const preferred = (await readConfig(host.git, host.cwd, 'remote.pushDefault')) ?? 'origin';
  const ordered = [...host.refs.remotes].sort((a, b) => Number(b === preferred) - Number(a === preferred));
  return ordered.length === 1
    ? ordered[0]
    : host.ui.pick({ title, items: ordered.map((r) => ({ label: r, value: r })) });
}

/** Pushes `branch` to a remote of the user's choice and makes that its upstream. */
export async function publish(host: FlowHost, branch: string): Promise<void> {
  const remote = await pickRemote(host, publishPick(branch));
  if (remote === undefined) return;
  const op: Operation = {
    kind: 'push',
    branch,
    remote,
    dest: `refs/heads/${branch}`,
    setUpstream: true,
    forceWithLease: undefined,
  };
  if (await remoteRun(host, REMOTE_DOING.publishing(branch, remote), remote, op))
    await finish(host, { message: REMOTE_DONE.published(branch, remote) });
}

/** Pushes `tag` to a remote of the user's choice; git refuses to replace a different tag there. */
export async function pushTag(host: FlowHost, tag: string): Promise<void> {
  const remote = await pickRemote(host, pushTagPick(tag));
  if (remote === undefined) return;
  try {
    if (!(await remoteRun(host, REMOTE_DOING.pushingTag(tag, remote), remote, { kind: 'pushTag', remote, tag })))
      return;
  } catch (e) {
    if (!(e instanceof GitOpError && e.kind === 'tagExists')) throw e;
    notify(host, 'error', tagExistsOnRemote(tag, remote), ['Show Output'], () => {
      host.runner.showOutput();
    });
    return;
  }
  await finish(host, { message: REMOTE_DONE.tagPushed(tag, remote) });
}

/** Deletes tag `ref` from a remote of the user's choice; the local tag stays. */
export async function deleteRemoteTag(host: FlowHost, ref: Ref): Promise<void> {
  const tag = ref.short;
  const remote = await pickRemote(host, deleteRemoteTagPick(tag));
  if (remote === undefined) return;
  const at = await readCommit(host.git, host.cwd, ref.name);
  if (!(await host.ui.confirm(deleteRemoteTagConfirmation(tag, remote, at)))) return;
  const op: Operation = { kind: 'deleteRemoteRef', remote, ref: ref.name, lease: undefined };
  if (await remoteRun(host, REMOTE_DOING.deletingTag(tag, remote), remote, op))
    await finish(host, { message: REMOTE_DONE.remoteTagDeleted(tag, remote) });
}

/**
 * Deletes the branch of remote-tracking branch `ref` from its remote, leased on the commit the
 * confirmation counted from. `moved`: asked again after the lease failed and `ref` was fetched.
 */
export async function deleteRemoteBranch(host: FlowHost, ref: Ref, moved = false): Promise<void> {
  const rb = remoteBranch(ref.name, host.refs.remotes);
  if (!rb) throw new Error(`'${ref.short}' is not a branch of a known remote.`);
  const { remote, branch } = rb;
  const [tip, unmerged, tracking] = await Promise.all([
    readCommit(host.git, host.cwd, ref.name),
    readUnmergedRemoteCommits(host.git, host.cwd, remote, branch),
    readTrackingBranches(host.git, host.cwd, ref.name),
  ]);
  const ask = deleteRemoteBranchConfirmation(remote, branch, ref.short, tip, unmerged, tracking, moved);
  if (!(await host.ui.confirm(ask))) return;
  const dest = `refs/heads/${branch}`;
  const op: Operation = { kind: 'deleteRemoteRef', remote, ref: dest, lease: tip.hash };
  const label = REMOTE_DOING.deletingBranch(branch, remote);
  try {
    if (!(await remoteRun(host, label, remote, op, [{ rev: ref.name, hash: tip.hash, name: quote(ref.short) }])))
      return;
  } catch (e) {
    if (!(e instanceof GitOpError && e.kind === 'rejected')) throw e;
    // The lease failed: the remote has the branch elsewhere, or no longer has it.
    try {
      const fetch: Operation = { kind: 'fetch', remote, ref: dest };
      if (!(await remoteRun(host, REMOTE_DOING.fetching(remote), remote, fetch))) return;
    } catch (f) {
      if (!(f instanceof GitOpError && f.kind === 'noRemoteRef')) throw f;
      // Without a lease git deletes a ref the remote lacks, and with it the remote-tracking branch.
      if (await remoteRun(host, label, remote, { ...op, lease: undefined }))
        await finish(host, { message: REMOTE_DONE.remoteBranchGone(ref.short, remote) });
      return;
    }
    const now = await runGit(host.git, host.cwd, ['rev-parse', '--verify', '--quiet', ref.name]).then(
      (s) => s.trim(),
      () => undefined,
    );
    if (now === tip.hash) throw new Error(`git did not update ${ref.short}; see the output.`, { cause: e });
    return deleteRemoteBranch(host, ref, true);
  }
  await finish(host, { message: REMOTE_DONE.remoteBranchDeleted(branch, remote) });
}
