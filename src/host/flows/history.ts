import * as vscode from 'vscode';
import { autostashMessage, type StashChoice } from '../../core/autostash.ts';
import { MORE_HISTORY, type MergeMode, type Operation, type ResetMode } from '../../core/operations.ts';
import type { OperationState } from '../../core/repo-state.ts';
import {
  abortButton,
  abortConfirmation,
  alreadyBased,
  alreadyContains,
  dirtySection,
  type Confirmation,
  type HistoryFetch,
  gitFailure,
  HISTORY_DOING,
  HISTORY_DONE,
  IN_THE_WAY_OF,
  mergeConfirmation,
  pickConfirmation,
  quote,
  rebaseConfirmation,
  RESET_MODES,
  resetConfirmation,
  resetPick,
  shallowConfirmation,
  skipConfirmation,
  stashButtons,
  stashLabel,
  stillConflicted,
  stoppedMessage,
  UNRELATED,
} from '../../core/wording.ts';
import {
  countCommits,
  isAncestor,
  isShallow,
  readCommit,
  readConfigBool,
  readHead,
  readMergeBase,
  readRebaseCounts,
  readResetFacts,
  readStash,
  readStashTop,
  readUntrackedAt,
  readUpstream,
  type CommitInfo,
} from '../../git/facts.ts';
import { GitOpError } from '../../git/op.ts';
import { runGit } from '../../git/run.ts';
import { readOperationState } from '../../git/state.ts';
import { finish, headRef, notify, run, type Expect, type FlowHost, type Undo } from '../flow.ts';
import type { Exec } from '../runner.ts';
import type { TargetOf } from '../target.ts';
import {
  changes,
  gitRestoreConflicted,
  reportRestore,
  resolveConflicts,
  restore,
  runMovingUntracked,
  stashAround,
  type Restored,
} from './changes.ts';

/** A commit or ref a history operation starts from or goes onto. */
export interface Source {
  /** For rev-parse: a full ref name or a commit id. */
  rev: string;
  /** As `git merge` is given it: a commit id, or a ref name git reads as that ref (see refSource). */
  arg: string;
  /** As sentences name it: a quoted short name or a short id. */
  name: string;
  /** A ref that must not move between the confirmation and the operation. */
  ref?: string;
}

/** A merge source or rebase target from a menu target. */
export async function sourceOf(host: FlowHost, t: TargetOf<'commit' | 'branch' | 'remoteBranch'>): Promise<Source> {
  if (t.kind === 'commit') {
    const c = await readCommit(host.git, host.cwd, t.hash);
    return { rev: c.hash, arg: c.hash, name: c.short };
  }
  return refSource(host, t.ref);
}

/**
 * The ref `name` (full) as a merge source. git is given its short name, which the merge message
 * then names, unless git reads that name as another ref (a tag or a branch of the same name).
 */
export async function refSource(host: FlowHost, ref: { name: string; short: string }): Promise<Source> {
  const reads = await runGit(host.git, host.cwd, ['rev-parse', '--symbolic-full-name', ref.short, '--']).then(
    (out) => out.split('\n')[0],
    () => undefined,
  );
  return { rev: ref.name, arg: reads === ref.name ? ref.short : ref.name, name: quote(ref.short), ref: ref.name };
}

/** The branch HEAD is on (or HEAD itself), as Undo guards and sentences name it. */
interface Head {
  branch: string | undefined;
  hash: string;
  name: string;
  expect: Expect;
}

async function head(host: FlowHost): Promise<Head> {
  const h = await readHead(host.git, host.cwd);
  const name = h.branch === undefined ? 'HEAD' : quote(h.branch);
  return { ...h, name, expect: { rev: 'HEAD', hash: h.hash, name } };
}

/** Undo of a move of HEAD's branch: back where it was, keeping uncommitted changes. */
const moveUndo = (host: FlowHost, label: string, h: Head, after: string, mode: ResetMode = 'keep'): Undo => ({
  label,
  repo: host.cwd,
  guard: { kind: 'head', ref: headRef(h.branch), before: h.hash, after },
  inverse: [{ kind: 'reset', commit: h.hash, mode }],
  focus: h.hash,
});

const sourceExpect = (s: Source, hash: string): Expect[] =>
  s.ref === undefined ? [] : [{ rev: s.ref, hash, name: s.name }];

/**
 * Whether lines `a` and `b` (as sentences name them: `names`) share a commit here, as `op` needs.
 * git refuses to merge unrelated histories but rebases onto them, replaying every commit; a
 * shallow clone may just lack their common commit. Resolves true when `op` can go ahead.
 */
async function deepEnough(
  host: FlowHost,
  op: 'merge' | 'rebase',
  a: string,
  b: string,
  names: [string, string],
): Promise<boolean> {
  if ((await readMergeBase(host.git, host.cwd, a, b)) !== undefined) return true;
  const shallow = await isShallow(host.git, host.cwd);
  if (op === 'rebase' && !shallow) return true;
  await noCommonCommit(host, names, shallow);
  return false;
}

/** For two lines with no common commit here, offers to fetch the history a shallow clone lacks, or says so. */
async function noCommonCommit(host: FlowHost, names: [string, string], shallow: boolean): Promise<void> {
  if (shallow) await fetchHistory(host, shallowConfirmation(...names));
  else void host.ui.notify('error', UNRELATED);
}

/** Asks `question` about a shallow clone, then fetches more of its history or all of it, as answered. */
async function fetchHistory(host: FlowHost, question: Confirmation<HistoryFetch>): Promise<void> {
  const answer = await host.ui.confirm(question);
  if (answer === undefined) return;
  const op: Operation =
    answer === 'deepen'
      ? { kind: 'fetch', remote: undefined, deepen: MORE_HISTORY }
      : { kind: 'fetch', remote: undefined, unshallow: true };
  const ran = await run(host, HISTORY_DOING.fetchingHistory[answer], (exec) => exec(op), { remote: true });
  if (ran !== undefined) await finish(host, { message: HISTORY_DONE.fetchedHistory[answer] });
}

/**
 * After an operation stopped, git keeping it in progress: shows where, and how to go on. `reason`:
 * git's own words, for a stop without conflicts (a cherry pick with nothing left to commit).
 */
async function stopped(host: FlowHost, state: OperationState, reason: string): Promise<void> {
  await host.refresh((await readHead(host.git, host.cwd)).hash);
  const [subject, held] = await Promise.all([
    state.applying === undefined ? undefined : readCommit(host.git, host.cwd, state.applying).then((c) => c.subject),
    heldStash(host, state),
  ]);
  const message = stoppedMessage(
    state.kind,
    state.step,
    subject,
    state.conflicts,
    state.conflictCount,
    held && stashLabel(held.index, held.message),
    reason,
  );
  const skips = state.kind === 'cherryPick' || state.kind === 'revert';
  const actions =
    state.conflictCount > 0
      ? ['Resolve...', abortButton(state.kind)]
      : [...(skips ? ['Skip...'] : []), abortButton(state.kind)];
  notify(host, 'warning', message, actions, (a) =>
    a === 'Resolve...'
      ? resolveConflicts(host, state.conflicts)
      : a === 'Skip...'
        ? skipCommit(host)
        : abortOperation(host),
  );
}

/**
 * The stash Strata pushed before the stopped cherry pick or revert `state` (git holds a rebase's
 * or merge's itself). Any other stash, even one named like Strata's, is not this operation's.
 */
async function heldStash(host: FlowHost, state: OperationState) {
  const hash = await host.leftovers.held(state);
  return hash === undefined ? undefined : readStash(host.git, host.cwd, hash);
}

/**
 * Runs an operation that may stop (`attempt` runs it, as run() does); resolves its stderr, or
 * undefined when it stopped or did not run. It stopped when git failed and left it in progress (at
 * conflicts, or with nothing to commit).
 */
async function runStoppable(
  host: FlowHost,
  attempt: () => Promise<{ stderr: string; restored?: Restored } | undefined>,
): Promise<{ stderr: string; restored?: Restored } | undefined> {
  try {
    return await attempt();
  } catch (e) {
    if (!(e instanceof GitOpError)) throw e;
    const state = await readOperationState(host.git, host.cwd);
    if (!state) throw e;
    await stopped(host, state, gitFailure(e.message).split('\n')[0]!);
    return undefined;
  }
}

/**
 * The success of an operation git may have finished with a conflicting autostash restore
 * (exit 0), or Strata with a conflicting pop: report it after the usual feedback.
 */
async function finishWithRestore(
  host: FlowHost,
  r: { stderr: string; restored?: Restored },
  done: { message: string; focus: string; undo?: Undo },
): Promise<void> {
  const restored = r.restored ?? (await gitRestoreConflicted(host, r.stderr));
  await finish(host, done);
  await reportRestore(host, done.message, restored);
}

export async function merge(host: FlowHost, src: Source, ask: 'always' | 'whenDirty' = 'always'): Promise<void> {
  const [h, from] = await Promise.all([head(host), readCommit(host.git, host.cwd, src.rev)]);
  if (await isAncestor(host.git, host.cwd, from.hash, h.hash)) {
    void host.ui.notify('info', alreadyContains(h.name, src.name));
    return;
  }
  if (!(await deepEnough(host, 'merge', h.hash, from.hash, [h.name, src.name]))) return;
  const [canFastForward, count, c, mergeFf] = await Promise.all([
    isAncestor(host.git, host.cwd, h.hash, from.hash),
    countCommits(host.git, host.cwd, [`${h.hash}..${from.hash}`]),
    changes(host, 'merge'),
    readConfigBool(host.git, host.cwd, 'merge.ff'),
  ]);
  const facts = { src: src.name, into: h.name, short: from.short, count, canFastForward };
  let mode: MergeMode = mergeFf === false ? 'noFastForward' : 'ff';
  let autostash = false;
  if (c.choices.choices.length > 0) {
    const answer = await host.ui.confirm(
      mergeConfirmation(facts, mergeFf, {
        section: c.section,
        buttons: stashButtons('merge', c.choices.choices),
        mode,
      }),
    );
    if (answer === undefined) return;
    autostash = answer === 'stash';
  } else if (ask === 'always') {
    const answer = await host.ui.confirm(mergeConfirmation(facts, mergeFf));
    if (answer === undefined) return;
    mode = answer === 'noFastForward' ? 'noFastForward' : 'ff';
  } else mode = 'ff';
  const r = await runStoppable(host, () =>
    runMovingUntracked(
      host,
      HISTORY_DOING.merging(src.name, h.name),
      IN_THE_WAY_OF.merge(src.name),
      (exec) => exec({ kind: 'merge', ref: src.arg, mode, autostash }),
      [h.expect, ...sourceExpect(src, from.hash)],
    ),
  ).catch(async (e: unknown) => {
    // The history changed after deepEnough read it (a fetch, a replaced commit).
    if (!(e instanceof GitOpError) || e.kind !== 'unrelated') throw e;
    await noCommonCommit(host, [h.name, src.name], await isShallow(host.git, host.cwd));
    return undefined;
  });
  if (!r) return;
  const after = await readHead(host.git, host.cwd);
  if (after.hash === h.hash) throw new Error(`git did not merge ${src.name}; see the output.`);
  const fastForwarded = after.hash === from.hash;
  await finishWithRestore(host, r, {
    message: fastForwarded ? HISTORY_DONE.fastForwarded(h.name, from.short) : HISTORY_DONE.merged(src.name, h.name),
    focus: after.hash,
    undo: moveUndo(host, 'merge', h, after.hash),
  });
}

/** `from`: replay only the commits after it (a pull's fork point), not every commit `onto` lacks. */
export async function rebase(
  host: FlowHost,
  onto: Source,
  ask: 'always' | 'whenDirty' = 'always',
  from?: string,
): Promise<void> {
  const [h, target] = await Promise.all([head(host), readCommit(host.git, host.cwd, onto.rev)]);
  if (await isAncestor(host.git, host.cwd, target.hash, h.hash)) {
    void host.ui.notify('info', alreadyBased(h.name, onto.name));
    return;
  }
  if (!(await deepEnough(host, 'rebase', h.hash, target.hash, [h.name, onto.name]))) return;
  const upstream = h.branch === undefined ? undefined : await readUpstream(host.git, host.cwd, h.branch);
  const [counts, c] = await Promise.all([
    readRebaseCounts(host.git, host.cwd, target.hash, upstream?.ref, from),
    changes(host, 'rebase'),
  ]);
  const dirty = c.choices.choices.length > 0;
  if (dirty || ask === 'always') {
    const buttons: { id: StashChoice | 'rebase'; label: string }[] = dirty
      ? stashButtons('rebase', c.choices.choices)
      : [{ id: 'rebase', label: 'Rebase' }];
    const facts = { branch: h.name, onto: onto.name, ontoShort: target.short, ...counts, upstream: upstream?.name };
    if ((await host.ui.confirm(rebaseConfirmation(facts, c.section, buttons))) === undefined) return;
  }
  const r = await runStoppable(host, () =>
    runMovingUntracked(
      host,
      HISTORY_DOING.rebasing(h.name, onto.name),
      IN_THE_WAY_OF.rebase(onto.name),
      (exec) => exec({ kind: 'rebase', onto: target.hash, from, autostash: dirty }),
      [h.expect, ...sourceExpect(onto, target.hash)],
    ),
  );
  if (!r) return;
  const after = await readHead(host.git, host.cwd);
  await finishWithRestore(host, r, {
    message: HISTORY_DONE.rebased(h.name, onto.name, counts.replay),
    focus: after.hash,
    undo: moveUndo(host, 'rebase', h, after.hash),
  });
}

/** Cherry pick or revert of `hash` on HEAD. */
export async function pick(host: FlowHost, kind: 'cherryPick' | 'revert', hash: string): Promise<void> {
  const [h, c] = await Promise.all([head(host), readCommit(host.git, host.cwd, hash)]);
  if (kind === 'cherryPick' && (await isAncestor(host.git, host.cwd, c.hash, h.hash))) {
    void host.ui.notify('info', alreadyContains(h.name, c.short));
    return;
  }
  const ch = await changes(host, kind);
  const detached = h.branch === undefined;
  let choice: StashChoice | 'go' | undefined = 'go';
  if (ch.choices.choices.length > 0 || detached) {
    const buttons: { id: StashChoice | 'go'; label: string }[] =
      ch.choices.choices.length > 0
        ? stashButtons(kind, ch.choices.choices)
        : [{ id: 'go', label: kind === 'cherryPick' ? 'Cherry Pick' : 'Revert' }];
    choice = await host.ui.confirm(pickConfirmation(kind, c, h.name, detached, ch.section, buttons));
    if (choice === undefined) return;
  }
  const op: Operation =
    kind === 'cherryPick' ? { kind: 'cherryPick', commit: c.hash } : { kind: 'revert', commit: c.hash };
  const label = kind === 'cherryPick' ? HISTORY_DOING.picking(c.short) : HISTORY_DOING.reverting(c.short);
  const r = await runStoppable(host, () =>
    runMovingUntracked(
      host,
      label,
      IN_THE_WAY_OF[kind](c.short),
      async (exec) => {
        if (choice !== 'stash') return exec(op);
        const message = autostashMessage(kind, `${c.short} onto ${h.name}`);
        let stderr = '';
        const restored = await stashAround(host, exec, message, async () => {
          stderr = (await exec(op)).stderr;
        });
        return { stderr, restored };
      },
      [h.expect],
    ),
  );
  if (!r) return;
  const after = await readHead(host.git, host.cwd);
  await finishWithRestore(host, r, {
    message: kind === 'cherryPick' ? HISTORY_DONE.picked(c.short, h.name) : HISTORY_DONE.reverted(c.short),
    focus: after.hash,
    undo: moveUndo(host, kind === 'cherryPick' ? 'cherry pick' : 'revert', h, after.hash),
  });
}

/** Reset modes Undo uses: soft and mixed undo themselves, keep and hard undo as keep (never discarding). */
const UNDO_MODE: Record<ResetMode, ResetMode> = { soft: 'soft', mixed: 'mixed', keep: 'keep', hard: 'keep' };

export async function reset(host: FlowHost, target: string): Promise<void> {
  const [h, t] = await Promise.all([head(host), readCommit(host.git, host.cwd, target)]);
  const leaving = await countCommits(host.git, host.cwd, [`${t.hash}..${h.hash}`]);
  const mode = await host.ui.pick({
    ...resetPick(h.name, t, leaving),
    items: RESET_MODES.map((m) => ({ label: m.label, description: m.description, value: m.mode })),
  });
  if (mode === undefined) return;
  const op = mode === 'hard' ? 'resetHard' : mode === 'keep' ? 'resetKeep' : undefined;
  const c = op === undefined ? undefined : await changes(host, op, t.hash);
  const overwritten = mode === 'hard' ? await readUntrackedAt(host.git, host.cwd, t.hash) : [];
  const facts = await readResetFacts(host.git, host.cwd, t.hash, c?.dirty.files ?? 0);
  // A hard reset over untracked files at paths it restores needs the same answer as over changes.
  const choices: StashChoice[] =
    mode === 'hard' && overwritten.length > 0 && c?.choices.choices.length === 0
      ? ['stash', 'discard']
      : (c?.choices.choices ?? []);
  const ask = resetConfirmation(facts, mode, choices.length > 0);
  let answer: StashChoice | 'reset' | undefined = 'reset';
  if (ask) {
    const section =
      c && choices.length > 0
        ? dirtySection(c.dirty, c.choices, c.worktree.submodules, mode === 'hard' ? overwritten : undefined)
        : '';
    answer = await host.ui.confirm({
      ...ask,
      detail: [ask.detail, section].filter((s) => s !== '').join(' '),
      buttons: choices.length > 0 ? stashButtons(op ?? 'resetKeep', choices) : ask.buttons,
    });
    if (answer === undefined) return;
  }
  const safety = answer === 'stash';
  const ran = await run(
    host,
    HISTORY_DOING.resetting(h.name, t.short),
    async (exec) => {
      if (safety) {
        // Never popped: it keeps what the reset would otherwise discard or overwrite.
        // With paths, only those: --all for overwritten files that are ignored, and none of the
        // staged deletions, which leave no file for a path to match (the reset restores them).
        const changed = c?.worktree.paths.filter((p) => !c.worktree.deleted.includes(p)) ?? [];
        await exec({
          kind: 'stashPush',
          message: `Strata: before reset of ${h.branch ?? 'HEAD'} to ${t.short}`,
          untracked: overwritten.length > 0 ? 'all' : 'none',
          ...(overwritten.length > 0 ? { paths: [...changed, ...overwritten] } : {}),
        });
      }
      await exec({ kind: 'reset', commit: t.hash, mode });
      return true;
    },
    { expect: [h.expect] },
  );
  if (ran === undefined) return;
  const stash = safety ? await safetyStash(host) : undefined;
  await finish(host, {
    message: HISTORY_DONE.reset(h.name, t.short, stash),
    focus: t.hash,
    undo: moveUndo(host, 'reset', h, t.hash, UNDO_MODE[mode]),
  });
}

async function safetyStash(host: FlowHost): Promise<string | undefined> {
  const top = await readStashTop(host.git, host.cwd);
  const s = top === undefined ? undefined : await readStash(host.git, host.cwd, top);
  return s && stashLabel(s.index, s.message);
}

async function inProgress(host: FlowHost): Promise<OperationState | undefined> {
  const state = await readOperationState(host.git, host.cwd);
  if (!state) await host.refresh();
  return state;
}

/**
 * After Continue, Abort or Skip ended a cherry pick or revert, puts back what Strata stashed
 * before it; git restores its own autostash for rebase and merge.
 */
async function restoreHeld(host: FlowHost, exec: Exec, state: OperationState): Promise<Restored> {
  if (await readOperationState(host.git, host.cwd)) return { kind: 'none' };
  const held = await heldStash(host, state);
  return held ? restore(host, exec, held.hash) : { kind: 'none' };
}

/** Continue, Abort or Skip, and what follows: stopping again, or restoring stashed changes. */
async function settle(
  host: FlowHost,
  state: OperationState,
  label: string,
  op: Operation,
  done: string,
): Promise<void> {
  const r = await runStoppable(host, () =>
    run(host, label, async (exec) => {
      const { stderr } = await exec(op);
      return { stderr, restored: await restoreHeld(host, exec, state) };
    }),
  );
  if (!r) return;
  const after = await readHead(host.git, host.cwd);
  await finishWithRestore(
    host,
    { stderr: r.stderr, ...(r.restored?.kind === 'none' ? {} : { restored: r.restored! }) },
    {
      message: done,
      focus: after.hash,
    },
  );
}

export async function continueOperation(host: FlowHost): Promise<void> {
  const state = await inProgress(host);
  if (!state) return;
  if (state.conflictCount > 0) {
    if (await host.ui.confirm(stillConflicted(state.conflicts, state.conflictCount)))
      await vscode.commands.executeCommand('workbench.view.scm');
    return;
  }
  const op: Operation = { kind: 'continue', operation: state.kind };
  await settle(host, state, HISTORY_DOING.continuing(state.kind), op, HISTORY_DONE.continued(state.kind));
}

export async function abortOperation(host: FlowHost): Promise<void> {
  const state = await inProgress(host);
  if (!state) return;
  // Rebase and merge go back to ORIG_HEAD (the tip before they started); a pick stops on HEAD itself.
  const back = await readCommit(
    host.git,
    host.cwd,
    state.kind === 'rebase' || state.kind === 'merge' ? 'ORIG_HEAD' : 'HEAD',
  );
  const held = state.autostash || (await heldStash(host, state)) !== undefined;
  if (!(await host.ui.confirm(abortConfirmation(state.kind, state.branch, back.short, held)))) return;
  const op: Operation = { kind: 'abort', operation: state.kind };
  await settle(host, state, HISTORY_DOING.aborting(state.kind), op, HISTORY_DONE.aborted(state.kind));
}

export async function skipCommit(host: FlowHost): Promise<void> {
  const state = await inProgress(host);
  if (!state || state.kind === 'merge' || state.applying === undefined) return;
  const c: CommitInfo = await readCommit(host.git, host.cwd, state.applying);
  const branch = state.branch === undefined ? 'HEAD' : quote(state.branch);
  if (!(await host.ui.confirm(skipConfirmation(c, branch)))) return;
  const op: Operation = { kind: 'skip', operation: state.kind };
  await settle(host, state, HISTORY_DOING.skipping(c.short), op, HISTORY_DONE.skipped(c.short));
}
