import type { Operation } from '../../core/operations.ts';
import {
  detachedNoBranch,
  divergedConfirmation,
  forcePushConfirmation,
  NO_REMOTE,
  noUpstream,
  publishPick,
  PULL_NOTES,
  pushOtherNameConfirmation,
  pushRejectedConfirmation,
  quote,
  REMOTE_DOING,
  REMOTE_DONE,
} from '../../core/wording.ts';
import { countCommits, readCommit, readConfig, readHead, readUpstream } from '../../git/facts.ts';
import { GitOpError } from '../../git/op.ts';
import { runGit } from '../../git/run.ts';
import { fail, finish, notify, run, type FlowHost } from '../flow.ts';
import { merge, rebase, refSource } from './history.ts';

/** Runs a remote operation; a failed sign-in becomes the Run in Terminal question. Resolves whether it ran. */
async function remoteRun(host: FlowHost, label: string, remote: string | undefined, op: Operation): Promise<boolean> {
  try {
    return (await run(host, label, (exec) => exec(op), { remote: true })) !== undefined;
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
  const tracking = `refs/remotes/${upstream.name}`;
  const [ahead, behind] = await Promise.all([
    countCommits(host.git, host.cwd, [`${tracking}..HEAD`]),
    countCommits(host.git, host.cwd, [`HEAD..${tracking}`]),
  ]);
  if (behind === 0) {
    await host.refresh();
    host.done(REMOTE_DONE.upToDate);
    return;
  }
  const src = await refSource(host, { name: tracking, short: upstream.name });
  if (ahead === 0) return merge(host, src, 'whenDirty');
  const [rebaseCfg, ff] = await Promise.all([
    readConfig(host.git, host.cwd, `branch.${branch}.rebase`).then(
      async (v) => v ?? (await readConfig(host.git, host.cwd, 'pull.rebase')),
    ),
    readConfig(host.git, host.cwd, 'pull.ff'),
  ]);
  const rebaseFirst = rebaseCfg === undefined ? undefined : BOOL[rebaseCfg.toLowerCase()];
  const canMerge = ff !== 'only';
  if (rebaseFirst === true) return rebase(host, src, 'whenDirty');
  if (rebaseFirst === false && canMerge) return merge(host, src, 'whenDirty');
  // Unset, "merges" or "interactive": ask, saying what Strata can do.
  const note = !canMerge ? PULL_NOTES.ffOnly : rebaseCfg?.startsWith('m') ? PULL_NOTES.rebaseMerges : undefined;
  const answer = await host.ui.confirm(
    divergedConfirmation(quote(branch), upstream.name, ahead, behind, { rebase: true, merge: canMerge }, note),
  );
  if (answer === 'rebase') await rebase(host, src, 'whenDirty');
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
  const destName = `${remote}/${destBranch}`;
  const op: Operation = { kind: 'push', branch, remote, dest, setUpstream: false, forceWithLease: undefined };
  try {
    if (!(await remoteRun(host, REMOTE_DOING.pushing(branch, destName), remote, op))) return;
  } catch (e) {
    if (e instanceof GitOpError && e.kind === 'rejected') return rejected(host, op, destName, local.hash);
    throw e;
  }
  await finish(host, { message: REMOTE_DONE.pushed(branch, destName) });
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
  const tracking = `refs/remotes/${destName}`;
  const theirs = await runGit(host.git, host.cwd, ['rev-parse', '--verify', '--quiet', tracking]).then(
    (s) => s.trim(),
    () => undefined,
  );
  if (theirs === undefined) throw new Error(`git did not fetch ${destName}; see the output.`);
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

/** Pushes `branch` to a remote of the user's choice and makes that its upstream. */
export async function publish(host: FlowHost, branch: string): Promise<void> {
  if (!hasRemote(host)) return;
  const remotes = host.refs.remotes;
  const preferred = (await readConfig(host.git, host.cwd, 'remote.pushDefault')) ?? 'origin';
  const ordered = [...remotes].sort((a, b) => Number(b === preferred) - Number(a === preferred));
  const remote =
    ordered.length === 1
      ? ordered[0]
      : await host.ui.pick({ title: publishPick(branch), items: ordered.map((r) => ({ label: r, value: r })) });
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
