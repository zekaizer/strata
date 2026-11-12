import { cleanMessage, chain, inPlace, planOf, refFates, todoText } from '../../core/rewrite.ts';
import type { Edit, EditKind, LineCommit, NewCommit, RefFates, RewritePlan } from '../../core/rewrite.ts';
import {
  editOutdated,
  fixupPick,
  MESSAGE_LIMIT,
  messageTooLong,
  notMovedAlong,
  plural,
  refName,
  REWRITE_DOING,
  REWRITE_DONE,
  REWRITE_UNDO,
  rewriteConfirmation,
  rewriteEffects,
  rewriteInTheWay,
  rewriteRefused,
  undoRewriteOutdated,
  type RewriteFacts,
} from '../../core/wording.ts';
import { readConfigBool, readGitVersion, readUpstream } from '../../git/facts.ts';
import { GitOpError } from '../../git/op.ts';
import {
  readLine,
  readRefsHaving,
  readRemoteHaving,
  readUnpushed,
  runCommitMsgHook,
  writeTodo,
} from '../../git/rewrite.ts';
import { runGit } from '../../git/run.ts';
import { finish, finishWithWarning, headRef, run, type Expect, type FlowHost, type Undo } from '../flow.ts';
import { changes, execAutostash, finishRestoring, runMovingUntracked } from './changes.ts';
import { head, moveUndo, runStoppable, type Head } from './history.ts';

/** Shown in a fixup's pick at most; older commits are left out. */
const PICK_LIMIT = 200;

/** An edit checked against the repository as it is now, with what it rewrites and moves. */
interface Prepared {
  edit: Edit;
  h: Head;
  line: readonly LineCommit[];
  plan: RewritePlan;
  /** The commits commit-tree makes, when the plan keeps every commit in place. */
  made: NewCommit[] | undefined;
  fates: RefFates;
  facts: RewriteFacts;
  /** Short ids by full id, of the commits the plan touches. */
  short: ReadonlyMap<string, string>;
}

/** The commits an edit names, newest first, and the one the result is shown at. */
function named(edit: Edit): { newest: string; oldest: string; focus: string } {
  switch (edit.kind) {
    case 'reword':
      return { newest: edit.commit, oldest: edit.commit, focus: edit.commit };
    case 'fixup':
      return { newest: edit.commit, oldest: edit.into, focus: edit.into };
    default:
      return { newest: edit.newest, oldest: edit.oldest, focus: edit.oldest };
  }
}

async function shortIds(host: FlowHost, hashes: readonly string[]): Promise<Map<string, string>> {
  const out = await runGit(host.git, host.cwd, ['log', '--no-walk=unsorted', '--format=%H %h', ...hashes, '--']);
  const found = new Map(out.split('\n').map((l) => l.split(' ') as [string, string]));
  return new Map(hashes.map((h) => [h, found.get(h) ?? h.slice(0, 7)]));
}

/** HEAD's line down to `oldest`, or a notice saying why there is none. */
async function lineTo(host: FlowHost, h: Head, oldest: string): Promise<readonly LineCommit[] | undefined> {
  const line = await readLine(host.git, host.cwd, oldest);
  if (line[line.length - 1]?.hash === oldest) return line;
  const [short] = (await shortIds(host, [oldest])).values();
  void host.ui.notify('info', rewriteRefused('notOnHeadLine', short ?? oldest, h.name));
  return undefined;
}

/** An edit planned on HEAD's line as it is now, before reading what else it touches. */
type Planned = Omit<Prepared, 'fates' | 'facts'>;

/** Plans `edit` on HEAD's line; resolves undefined, having said why, when it cannot be carried out. */
async function plan(host: FlowHost, edit: Edit, line?: readonly LineCommit[]): Promise<Planned | undefined> {
  const h = await head(host);
  const n = named(edit);
  const read = line ?? (await lineTo(host, h, n.oldest));
  if (!read) return undefined;
  const planned = planOf(edit, read);
  if (typeof planned === 'string') {
    const [short] = (await shortIds(host, [n.newest])).values();
    void host.ui.notify('info', rewriteRefused(planned, short ?? n.newest, h.name));
    return undefined;
  }
  const made = inPlace(planned, read) ? chain(planned, read) : undefined;
  const short = await shortIds(
    host,
    planned.steps.map((st) => st.commit),
  );
  return { edit, h, line: read, plan: planned, made, short };
}

/**
 * Reads what a planned edit touches besides HEAD's branch: which rewritten commits a remote has,
 * and which local branches and tags are on them. Without a commit-graph this takes a few hundred
 * milliseconds on a large repository (refs on other lines are walked back to the commits' date).
 */
async function survey(host: FlowHost, p: Planned): Promise<Prepared> {
  const { edit, h, plan: planned, made, short } = p;
  const n = named(edit);
  const rewritten = new Set(planned.steps.map((st) => st.commit));
  const ref = headRef(h.branch);
  // Branches checked out in other worktrees, as the graph last read them.
  const elsewhere = new Set(host.refs.worktrees.flatMap((w) => (w.branch === undefined ? [] : [w.branch])));
  const [unpushed, having, upstream] = await Promise.all([
    readUnpushed(host.git, host.cwd, planned.base),
    readRefsHaving(host.git, host.cwd, planned.steps[0]!.commit),
    h.branch === undefined ? undefined : readUpstream(host.git, host.cwd, h.branch),
  ]);
  const pushed = p.line.filter((c) => rewritten.has(c.hash) && !unpushed.has(c.hash));
  const remote =
    pushed[0] && ((await readRemoteHaving(host.git, host.cwd, pushed[0].hash, upstream?.ref)) ?? 'a remote branch');
  const fates = refFates(
    having
      .filter((r) => r.name !== ref)
      .map((r) => ({ ...r, elsewhere: r.kind === 'branch' && elsewhere.has(r.name) })),
    rewritten,
    made,
  );
  const at = new Map(p.line.map((c, i) => [c.hash, i]));
  const s = (hash: string) => short.get(hash) ?? hash.slice(0, 7);
  const count = at.get(n.oldest)! - at.get(n.newest)! + 1;
  const what = {
    reword: () => s(n.newest),
    squash: () => plural(count, 'commit'),
    fixup: () => `${s(n.newest)} into ${s(n.oldest)}`,
    drop: () => plural(count, 'commit'),
  } satisfies Record<EditKind, () => string>;
  const facts: RewriteFacts = {
    edit: edit.kind,
    branch: h.name,
    what: what[edit.kind](),
    onTop: at.get(edit.kind === 'fixup' ? n.oldest : n.newest)! - (edit.kind === 'fixup' ? 1 : 0),
    pushed:
      remote === undefined ? undefined : { count: pushed.length, remote, canForce: host.settings().allowForcePush },
    moves: fates.moves.map((m) => m.ref.short),
    stays: fates.stays.map((st) => ({ name: st.ref.short, why: st.why })),
  };
  return { ...p, fates, facts };
}

/** Plans `edit` and reads what it touches; undefined when it cannot be carried out. */
async function prepare(host: FlowHost, edit: Edit, line?: readonly LineCommit[]): Promise<Prepared | undefined> {
  const p = await plan(host, edit, line);
  return p && survey(host, p);
}

/**
 * Edit Message... and Squash Selected Commits...: opens the inline editor on `oldest`..`newest` as
 * soon as the edit is planned, then tells it what saving rewrites.
 */
export async function openEditor(host: FlowHost, kind: 'reword' | 'squash', oldest: string, newest: string) {
  const h = await head(host);
  const line = await lineTo(host, h, oldest);
  if (!line) return;
  const first = line[line.length - 1]!;
  // Planned with a placeholder: an empty message is refused at Save, not when opening.
  const edit: Edit =
    kind === 'reword' ? { kind, commit: oldest, message: 'x' } : { kind, oldest, newest, message: 'x' };
  const p = await plan(host, edit, line);
  if (!p) return;
  const from = line.findIndex((c) => c.hash === newest);
  const commits = line
    .slice(from)
    .reverse()
    .map((c) => ({
      hash: c.hash,
      short: p.short.get(c.hash) ?? c.hash.slice(0, 7),
      subject: c.message.split('\n')[0] ?? '',
      message: c.message,
    }));
  host.openEditor({ kind, head: h.hash, commits, message: cleanMessage(first.message), effects: undefined });
  host.editEffects(h.hash, rewriteEffects((await survey(host, p)).facts));
}

/** Save in the message editor: the edit, unless HEAD moved since it opened at `opened`. Resolves whether it was applied. */
export async function saveEdit(host: FlowHost, edit: Edit, opened: string): Promise<boolean> {
  const h = await head(host);
  if (h.hash !== opened) {
    void host.ui.notify('info', editOutdated(h.name));
    return false;
  }
  return rewrite(host, edit);
}

export async function fixupIntoParent(host: FlowHost, hash: string): Promise<void> {
  const h = await head(host);
  const line = await lineTo(host, h, hash);
  if (!line) return;
  const parent = line[line.length - 1]!.parents[0];
  if (parent === undefined) {
    const [short] = (await shortIds(host, [hash])).values();
    void host.ui.notify('info', rewriteRefused('noParent', short ?? hash, h.name));
    return;
  }
  await rewrite(host, { kind: 'fixup', commit: hash, into: parent });
}

/** Asks which older commit of HEAD's line (down to a merge) `hash` belongs to, then fixes it up into that. */
export async function fixupIntoOlder(host: FlowHost, hash: string): Promise<void> {
  const h = await head(host);
  const line = await readLine(host.git, host.cwd, undefined);
  const at = line.findIndex((c) => c.hash === hash);
  if (at < 0) {
    const [short] = (await shortIds(host, [hash])).values();
    void host.ui.notify('info', rewriteRefused('notOnHeadLine', short ?? hash, h.name));
    return;
  }
  const merge = line.findIndex((c) => c.parents.length > 1);
  if (merge >= 0 && merge <= at) {
    const [short] = (await shortIds(host, [hash])).values();
    void host.ui.notify('info', rewriteRefused('merge', short ?? hash, h.name));
    return;
  }
  const older = line.slice(at + 1, merge < 0 ? undefined : merge).slice(0, PICK_LIMIT);
  if (older.length === 0) {
    const [short] = (await shortIds(host, [hash])).values();
    void host.ui.notify('info', rewriteRefused('noParent', short ?? hash, h.name));
    return;
  }
  const short = await shortIds(host, [hash, ...older.map((c) => c.hash)]);
  const subject = (c: LineCommit) => c.message.split('\n')[0] ?? '';
  const into = await host.ui.pick({
    ...fixupPick({ short: short.get(hash)!, subject: subject(line[at]!) }),
    items: older.map((c) => ({ label: subject(c), description: short.get(c.hash)!, value: c.hash })),
  });
  if (into === undefined) return;
  await rewrite(host, { kind: 'fixup', commit: hash, into }, line);
}

/** Drop Commit... and Drop Selected Commits...: `hashes` newest first, a run of HEAD's line. */
export async function dropCommits(host: FlowHost, hashes: readonly string[]): Promise<void> {
  await rewrite(host, { kind: 'drop', newest: hashes[0]!, oldest: hashes[hashes.length - 1]! });
}

/** Carries out `edit` after confirming what it rewrites; resolves whether it ran to the end. */
async function rewrite(host: FlowHost, edit: Edit, line?: readonly LineCommit[]): Promise<boolean> {
  const p = await prepare(host, edit, line);
  if (!p) return false;
  return p.made ? rewriteInPlace(host, p, p.made) : rewriteByRebase(host, p);
}

const label = (p: Prepared): string => {
  const n = named(p.edit);
  const s = (h: string) => p.short.get(h) ?? h.slice(0, 7);
  const count = p.plan.steps.filter((st) => st.action === 'drop').length;
  return {
    reword: () => REWRITE_DOING.reword(s(n.newest)),
    squash: () => REWRITE_DOING.squash(p.made?.find((c) => c.replaces.includes(n.oldest))?.replaces.length ?? 0),
    fixup: () => REWRITE_DOING.fixup(s(n.newest), s(n.oldest)),
    drop: () => REWRITE_DOING.drop(count, p.h.name),
  }[p.edit.kind]();
};

/** commit-tree for every new commit, then update-ref: the work tree, the index and the stashes stay as they are. */
async function rewriteInPlace(host: FlowHost, p: Prepared, made: NewCommit[]): Promise<boolean> {
  const ask = rewriteConfirmation(p.facts);
  const answer = ask === undefined ? 'only' : await host.ui.confirm(ask);
  if (answer === undefined) return false;
  const moves = answer === 'move' ? p.fates.moves : [];
  for (const c of made)
    if (c.message.length > MESSAGE_LIMIT) {
      void host.ui.notify('info', messageTooLong(c.message.length));
      return false;
    }
  const [sign, version] = await Promise.all([
    readConfigBool(host.git, host.cwd, 'commit.gpgSign'),
    readGitVersion(host.git, host.cwd),
  ]);
  const ref = headRef(p.h.branch);
  const reason = `strata: ${REWRITE_UNDO[p.edit.kind]}`;
  const notMoved: string[] = [];
  const moved: typeof moves = [];
  const ids = await run(
    host,
    label(p),
    async (exec) => {
      const ids: string[] = [];
      for (const c of made) {
        const message = c.edited
          ? cleanMessage(await runCommitMsgHook(host.git, host.cwd, version, c.message))
          : c.message;
        if (message === '') throw new Error(rewriteRefused('emptyMessage', '', p.h.name));
        const parent = c.parent === 'base' ? p.plan.base : ids[c.parent];
        const { stdout } = await exec({
          kind: 'commitTree',
          tree: c.tree,
          parents: parent === undefined ? [] : [parent],
          message,
          author: c.author,
          sign: sign === true,
        });
        ids.push(stdout.trim());
      }
      await exec({ kind: 'updateRef', ref, to: ids[ids.length - 1]!, from: p.h.hash, reason });
      for (const m of moves)
        try {
          await exec({ kind: 'updateRef', ref: m.ref.name, to: ids[m.to]!, from: m.ref.hash, reason });
          moved.push(m);
        } catch (e) {
          if (!(e instanceof GitOpError)) throw e;
          notMoved.push(m.ref.short);
        }
      return ids;
    },
    { expect: [p.h.expect] },
  );
  if (ids === undefined) return false;
  const newHead = ids[ids.length - 1]!;
  const undoLabel = REWRITE_UNDO[p.edit.kind];
  const focusOld = named(p.edit).focus;
  const focus = ids[made.findIndex((c) => c.replaces.includes(focusOld))] ?? newHead;
  const expect = (rev: string, hash: string, name: string): Expect => ({
    rev,
    hash,
    name,
    changed: undoRewriteOutdated(undoLabel, name),
  });
  const undo: Undo = {
    label: undoLabel,
    repo: host.cwd,
    guard: {
      kind: 'refs',
      expect: [
        expect(ref, newHead, p.h.name),
        ...moved.map((m) => expect(m.ref.name, ids[m.to]!, refName(m.ref.short))),
      ],
    },
    inverse: [
      { kind: 'updateRef', ref, to: p.h.hash, from: newHead, reason: `strata: undo ${undoLabel}` },
      ...moved.map((m) => ({
        kind: 'updateRef' as const,
        ref: m.ref.name,
        to: m.ref.hash,
        from: ids[m.to]!,
        reason: `strata: undo ${undoLabel}`,
      })),
    ],
    focus: focusOld,
  };
  const n = named(p.edit);
  const s = (h: string) => p.short.get(h) ?? h.slice(0, 7);
  const [nowShort] = (await shortIds(host, [focus])).values();
  const done = {
    reword: () => REWRITE_DONE.reword(s(n.oldest), nowShort ?? focus),
    squash: () =>
      REWRITE_DONE.squash(made.find((c) => c.replaces.includes(n.oldest))!.replaces.length, nowShort ?? focus),
    fixup: () => REWRITE_DONE.fixup(s(n.newest), s(n.oldest)),
    drop: () => REWRITE_DONE.drop(n.oldest === n.newest ? 1 : 0, p.h.name),
  }[p.edit.kind]();
  const message = REWRITE_DONE.moved(
    done,
    moved.map((m) => m.ref.short),
  );
  if (notMoved.length > 0)
    await finishWithWarning(host, { warning: notMovedAlong(message, notMoved), focus, undo }, [], () => undefined);
  else await finish(host, { message, focus, undo });
  return true;
}

/** An interactive rebase on the todo Strata wrote: it may stop at a conflict, which the banner takes on from there. */
async function rewriteByRebase(host: FlowHost, p: Prepared): Promise<boolean> {
  const c = await changes(host, 'rebase');
  const dirty = c.choices.choices.length > 0 ? { section: c.section, choices: c.choices.choices } : undefined;
  const ask = rewriteConfirmation(p.facts, dirty);
  if (ask !== undefined && (await host.ui.confirm(ask)) === undefined) return false;
  const todoPath = await writeTodo(host.git, host.cwd, todoText(p.plan));
  const r = await runStoppable(host, () =>
    runMovingUntracked(
      host,
      label(p),
      rewriteInTheWay(p.edit.kind, p.facts.what),
      (exec) => execAutostash(host, exec, { kind: 'rebaseTodo', base: p.plan.base, todoPath, autostash: !!dirty }),
      [p.h.expect],
    ),
  );
  if (!r) return false;
  const after = (await head(host)).hash;
  const n = named(p.edit);
  const s = (h: string) => p.short.get(h) ?? h.slice(0, 7);
  const dropped = p.plan.steps.filter((st) => st.action === 'drop').length;
  await finishRestoring(host, r, {
    message:
      p.edit.kind === 'drop' ? REWRITE_DONE.drop(dropped, p.h.name) : REWRITE_DONE.fixup(s(n.newest), s(n.oldest)),
    focus: after,
    undo: moveUndo(host, REWRITE_UNDO[p.edit.kind], p.h, after),
  });
  return true;
}
