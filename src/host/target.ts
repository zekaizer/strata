import type { Ref, RefKind, RefSnapshot } from '../core/refs.ts';
import { staleTarget } from '../core/wording.ts';
import { isCommitId } from '../git/details.ts';

/**
 * The graph element a command was invoked on, parsed from its menu context and checked against
 * the refs the graph shows. Flags the webview sets (current, upstream, merge) only decide which
 * menu items appear; flows read the facts from git again.
 */
export type Target =
  | { kind: 'commit'; hash: string }
  | { kind: 'stash'; hash: string }
  /** The detached HEAD badge. */
  | { kind: 'head'; hash: string }
  | { kind: 'branch'; ref: Ref }
  | { kind: 'remoteBranch'; ref: Ref }
  | { kind: 'tag'; ref: Ref };

export type TargetKind = Target['kind'];
export type TargetOf<K extends TargetKind> = Extract<Target, { kind: K }>;

/** A menu opened on a ref that no longer exists: the graph was older than the repository. */
export class StaleTarget extends Error {}

const REFS: Record<'branch' | 'remoteBranch' | 'tag', { kind: RefKind; prefix: string }> = {
  branch: { kind: 'branch', prefix: 'refs/heads/' },
  remoteBranch: { kind: 'remote', prefix: 'refs/remotes/' },
  tag: { kind: 'tag', prefix: 'refs/tags/' },
};

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Parses a menu context (`data-vscode-context` plus the webview id) into a target of one of
 * `kinds`. Throws on a malformed context, and StaleTarget for a ref missing from `refs`.
 */
export function parseTarget<K extends TargetKind>(ctx: unknown, kinds: readonly K[], refs: RefSnapshot): TargetOf<K> {
  const c = (typeof ctx === 'object' && ctx !== null ? ctx : {}) as Record<string, unknown>;
  const section = str(c['webviewSection']);
  if (!kinds.some((k) => k === section)) throw new Error(`not a menu of ${kinds.join(' or ')}: ${String(section)}`);
  const kind = section as TargetKind;
  if (kind === 'commit' || kind === 'stash' || kind === 'head') {
    const hash = str(c['strataHash']);
    if (!hash || !isCommitId(hash)) throw new Error('invalid commit id');
    return { kind, hash } as TargetOf<K>;
  }
  const name = str(c['strataRef']);
  const expected = REFS[kind];
  if (!name?.startsWith(expected.prefix)) throw new Error(`invalid ${kind} ref: ${String(name)}`);
  const ref = refs.refs.find((r) => r.name === name && r.kind === expected.kind);
  if (!ref) throw new StaleTarget(staleTarget(name.slice(expected.prefix.length)));
  return { kind, ref } as TargetOf<K>;
}
