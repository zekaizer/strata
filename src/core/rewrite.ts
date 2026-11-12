import type { Ident } from './operations.ts';

/** How far below HEAD a commit can be and still be rewritten. */
export const LINE_LIMIT = 1000;

/** A commit of HEAD's first-parent line, as a rewrite reads it. */
export interface LineCommit {
  hash: string;
  /** First parent first; empty for a root commit. */
  parents: readonly string[];
  tree: string;
  author: Ident;
  /** The raw message, as git stores it. */
  message: string;
}

/** What the user asked for, from a menu or the inline message editor. Hashes are full commit ids. */
export type Edit =
  | { kind: 'reword'; commit: string; message: string }
  /** `oldest` and `newest` bound a run of HEAD's line; the result has `oldest`'s author and date. */
  | { kind: 'squash'; oldest: string; newest: string; message: string }
  /** Melds `commit` into the older commit `into`, keeping `into`'s message. */
  | { kind: 'fixup'; commit: string; into: string }
  | { kind: 'drop'; oldest: string; newest: string }
  /** `order`: the new sequence, newest first, of the top of HEAD's line: the same commits as line[0..order.length-1]. */
  | { kind: 'reorder'; order: readonly string[] };

export type EditKind = Edit['kind'];

/**
 * One line of a rebase todo. A fixup melds into the step before it; the `message` of a squash
 * group is on its last fixup (and the group keeps its first commit's message without one).
 */
export type Step =
  | { action: 'pick'; commit: string }
  | { action: 'reword'; commit: string; message: string }
  | { action: 'fixup'; commit: string; message?: string }
  | { action: 'drop'; commit: string };

/** A rebase todo over HEAD's first-parent line from `base` (undefined: the root) to HEAD, oldest first. */
export interface RewritePlan {
  base: string | undefined;
  steps: readonly Step[];
}

/**
 * Why an edit cannot be planned: a commit is not on HEAD's first-parent line, a merge is in the
 * way (a merge or a merge newer than it), there is no parent to fold into, the commits are given
 * newest first, the message is empty, nothing would be left of the branch, or a reorder leaves
 * every commit where it is.
 */
export type Refusal = 'notOnHeadLine' | 'merge' | 'noParent' | 'order' | 'emptyMessage' | 'nothingLeft' | 'unchanged';

/**
 * git's "whitespace" cleanup: trailing spaces, leading and trailing blank lines and repeated blank
 * lines go; '#' lines stay (Markdown headings in a body). Ends in a newline unless empty.
 */
export function cleanMessage(text: string): string {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd());
  const kept: string[] = [];
  for (const l of lines) if (l !== '' || (kept.length > 0 && kept[kept.length - 1] !== '')) kept.push(l);
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
  return kept.length === 0 ? '' : `${kept.join('\n')}\n`;
}

/**
 * The todo that carries out `edit` on `line`, HEAD's first-parent line newest first (HEAD, its
 * first parent, ...), which reaches at least the oldest commit the edit names.
 */
export function planOf(edit: Edit, line: readonly LineCommit[]): RewritePlan | Refusal {
  if (edit.kind === 'reorder') return reorderPlan(edit.order, line);
  const at = new Map(line.map((c, i) => [c.hash, i]));
  const named =
    edit.kind === 'reword'
      ? [edit.commit, edit.commit]
      : edit.kind === 'fixup'
        ? [edit.commit, edit.into]
        : [edit.newest, edit.oldest];
  const indexes = named.map((h) => at.get(h));
  if (indexes.some((i) => i === undefined)) return 'notOnHeadLine';
  const [newer, older] = indexes as [number, number];
  if (newer > older || (edit.kind === 'fixup' && newer === older)) return 'order';
  const deepest = Math.max(newer, older);
  const span = line.slice(0, deepest + 1);
  if (span.some((c) => c.parents.length > 1)) return 'merge';
  const oldestFirst = span.map((c) => c.hash).reverse();
  const base = line[deepest]!.parents[0];
  const message = edit.kind === 'reword' || edit.kind === 'squash' ? cleanMessage(edit.message) : undefined;
  if (message === '') return 'emptyMessage';
  switch (edit.kind) {
    case 'reword':
      return {
        base,
        steps: oldestFirst.map((commit) =>
          commit === edit.commit ? { action: 'reword', commit, message: message! } : { action: 'pick', commit },
        ),
      };
    case 'squash': {
      if (newer === older) return planOf({ kind: 'reword', commit: edit.oldest, message: edit.message }, line);
      const group = new Set(line.slice(newer, older + 1).map((c) => c.hash));
      return {
        base,
        steps: oldestFirst.map((commit): Step => {
          if (commit === edit.oldest) return { action: 'pick', commit };
          if (commit === edit.newest) return { action: 'fixup', commit, message: message! };
          return group.has(commit) ? { action: 'fixup', commit } : { action: 'pick', commit };
        }),
      };
    }
    case 'fixup':
      return {
        base,
        steps: oldestFirst.flatMap((commit): Step[] => {
          if (commit === edit.commit) return [];
          if (commit === edit.into)
            return [
              { action: 'pick', commit },
              { action: 'fixup', commit: edit.commit },
            ];
          return [{ action: 'pick', commit }];
        }),
      };
    case 'drop': {
      if (newer === 0 && base === undefined) return 'nothingLeft';
      const dropped = new Set(line.slice(newer, older + 1).map((c) => c.hash));
      return {
        base,
        steps: oldestFirst.map((commit) => ({ action: dropped.has(commit) ? 'drop' : 'pick', commit })),
      };
    }
  }
}

/** Picks in the new order, from the deepest commit that changes place up: the ones below it are not replayed. */
function reorderPlan(order: readonly string[], line: readonly LineCommit[]): RewritePlan | Refusal {
  const top = line.slice(0, order.length);
  const given = new Set(order);
  if (top.length < order.length || given.size < order.length || top.some((c) => !given.has(c.hash)))
    return 'notOnHeadLine';
  const deepest = top.findLastIndex((c, i) => c.hash !== order[i]);
  if (deepest < 0) return 'unchanged';
  if (top.slice(0, deepest + 1).some((c) => c.parents.length > 1)) return 'merge';
  return {
    base: top[deepest]!.parents[0],
    steps: order
      .slice(0, deepest + 1)
      .reverse()
      .map((commit) => ({ action: 'pick', commit })),
  };
}

/** A plan's original commits, oldest first, as `line` (newest first) has them. */
const original = (plan: RewritePlan, line: readonly LineCommit[]): string[] => {
  const touched = new Set(plan.steps.map((s) => s.commit));
  return line
    .filter((c) => touched.has(c.hash))
    .map((c) => c.hash)
    .reverse();
};

/**
 * Whether every commit keeps its place and none is dropped: each new commit then has the tree of
 * an original one, so commit-tree builds them and the work tree is never touched.
 */
export function inPlace(plan: RewritePlan, line: readonly LineCommit[]): boolean {
  if (plan.steps.some((s) => s.action === 'drop')) return false;
  const order = original(plan, line);
  return plan.steps.every((s, i) => s.commit === order[i]);
}

/** A commit commit-tree makes for an in-place plan. */
export interface NewCommit {
  tree: string;
  /** The plan's base, or the new commit at that index of the chain. */
  parent: 'base' | number;
  author: Ident;
  message: string;
  /** The original commits it stands for, oldest first. */
  replaces: readonly string[];
  /** The original whose tree it has: a ref there moves to it unchanged in content. */
  last: string;
  /** Its message is the one the edit wrote (the repository's commit-msg hook runs on it). */
  edited: boolean;
}

/** The commits commit-tree makes for an in-place plan (inPlace), oldest first. */
export function chain(plan: RewritePlan, line: readonly LineCommit[]): NewCommit[] {
  if (!inPlace(plan, line)) throw new Error('only a plan that keeps every commit in place is chained');
  const byHash = new Map(line.map((c) => [c.hash, c]));
  const made: NewCommit[] = [];
  for (const s of plan.steps) {
    const c = byHash.get(s.commit)!;
    const group = s.action === 'fixup' ? made.pop() : undefined;
    const message = s.action === 'fixup' ? s.message : undefined;
    if (!group) {
      made.push({
        tree: c.tree,
        parent: made.length === 0 ? 'base' : made.length - 1,
        author: c.author,
        message: s.action === 'reword' ? s.message : c.message,
        replaces: [c.hash],
        last: c.hash,
        edited: s.action === 'reword',
      });
      continue;
    }
    made.push({
      ...group,
      tree: c.tree,
      message: message ?? group.message,
      replaces: [...group.replaces, c.hash],
      last: c.hash,
      edited: group.edited || message !== undefined,
    });
  }
  return made;
}

/** The git-rebase-todo text of a plan that changes no message. */
export function todoText(plan: RewritePlan): string {
  const lines = plan.steps.map((s) => {
    if (s.action === 'reword' || (s.action === 'fixup' && s.message !== undefined))
      throw new Error('a message is only written in place');
    return `${s.action} ${s.commit}`;
  });
  // git stops with "nothing to do" at a todo without a commit to apply.
  if (plan.steps.every((s) => s.action === 'drop')) lines.push('noop');
  return `${lines.join('\n')}\n`;
}

/** A local branch or tag that has a rewritten commit, other than the branch HEAD is on. */
export interface RefTip {
  /** Full name. */
  name: string;
  short: string;
  kind: 'branch' | 'tag';
  /** The commit it points at (a tag peeled). */
  hash: string;
  /** A branch checked out in another worktree. */
  elsewhere: boolean;
}

/**
 * Why a ref keeps the old commits: tags never move; a branch checked out in another worktree is
 * not moved under it; one at a commit that has no counterpart of the same content (in a squash,
 * or replayed by a rebase), or one that only branched off from the rewritten commits.
 */
export type StayReason = 'tag' | 'worktree' | 'old' | 'forked';

export interface RefFates {
  /** Branches that move to the new commit at that index of the chain. */
  moves: { ref: RefTip; to: number }[];
  stays: { ref: RefTip; why: StayReason }[];
}

/**
 * What happens to `refs` when the commits `rewritten` are replaced: by `made` (in place), or by
 * a rebase (undefined), which gives no exact counterpart of a commit.
 */
export function refFates(
  refs: readonly RefTip[],
  rewritten: ReadonlySet<string>,
  made: readonly NewCommit[] | undefined,
): RefFates {
  const fates: RefFates = { moves: [], stays: [] };
  for (const ref of refs) {
    const to = made?.findIndex((c) => c.last === ref.hash) ?? -1;
    const why: StayReason | undefined = !rewritten.has(ref.hash)
      ? 'forked'
      : ref.kind === 'tag'
        ? 'tag'
        : ref.elsewhere
          ? 'worktree'
          : to < 0
            ? 'old'
            : undefined;
    if (why === undefined) fates.moves.push({ ref, to });
    else fates.stays.push({ ref, why });
  }
  return fates;
}

/**
 * The commits that can be rewritten: HEAD's first-parent line, newest first, from `head` down to
 * the first merge, the root, LINE_LIMIT commits or the first commit `parentsOf` does not know.
 */
export function rewritableLine(
  head: string | undefined,
  parentsOf: (hash: string) => readonly string[] | undefined,
): string[] {
  const line: string[] = [];
  for (let h = head; h !== undefined && line.length < LINE_LIMIT;) {
    const parents = parentsOf(h);
    if (parents === undefined || parents.length > 1) break;
    line.push(h);
    h = parents[0];
  }
  return line;
}
