import type { Ref, RefSnapshot } from './refs.ts';

/**
 * A rule of the badge filter: badges of refs whose short name (main, origin/main, IR-1.2) matches
 * `pattern` are hidden, or shown again when `keep`. In a list the last matching rule decides; a
 * ref no rule matches is shown.
 *
 * `*` matches any run of characters, `/` included, `?` exactly one; the rest is literal and
 * case-sensitive. Git forbids `*`, `?` and `\` in ref names, so a short name is its own exact
 * pattern and needs no escape syntax.
 */
export interface BadgeRule {
  pattern: string;
  keep: boolean;
}

const GLOB: Record<string, string> = { '*': '.*', '?': '.' };

/** Whether search text is a glob rather than a substring to look for. */
export const isPattern = (text: string): boolean => /[*?]/.test(text);

/** Tests short names against a glob, compiled once. */
export function matcher(pattern: string): (short: string) => boolean {
  const source = pattern.replace(/[*?\\^$.|+()[\]{}]/g, (c) => GLOB[c] ?? `\\${c}`);
  const re = new RegExp(`^${source}$`, 's');
  return (short) => re.test(short);
}

/** Index of the last rule matching a short name, or -1. */
function decider(rules: readonly BadgeRule[]): (short: string) => number {
  const tests = rules.map((r) => matcher(r.pattern));
  return (short) => tests.findLastIndex((test) => test(short));
}

/** The rule that hides `short`'s badge, or undefined when it is shown. */
export function hidingRule(rules: readonly BadgeRule[], short: string): BadgeRule | undefined {
  const rule = rules[decider(rules)(short)];
  return rule?.keep === false ? rule : undefined;
}

/** How many refs of `snapshot` each rule decides (is the last match of), the current branch aside. */
export function ruleCounts(rules: readonly BadgeRule[], snapshot: RefSnapshot): number[] {
  const counts = rules.map(() => 0);
  const decide = decider(rules);
  for (const r of snapshot.refs) {
    if (isCurrent(r, snapshot)) continue;
    const i = decide(r.short);
    if (i >= 0) counts[i]!++;
  }
  return counts;
}

const isCurrent = (r: Ref, snapshot: RefSnapshot): boolean => r.kind === 'branch' && r.short === snapshot.headBranch;

/**
 * The refs of `snapshot` whose badges `rules` hide, by full name, with the rule hiding each. The
 * current branch is never hidden.
 */
export function hiddenRefs(rules: readonly BadgeRule[], snapshot: RefSnapshot): Map<string, BadgeRule> {
  const hidden = new Map<string, BadgeRule>();
  if (rules.length === 0) return hidden;
  const decide = decider(rules);
  for (const r of snapshot.refs) {
    if (isCurrent(r, snapshot)) continue;
    const rule = rules[decide(r.short)];
    if (rule?.keep === false) hidden.set(r.name, rule);
  }
  return hidden;
}

/**
 * `rules` with `rule` appended. Earlier rules of the same pattern go: the new one, matching the
 * same names later, overrides them. An exception with no hiding rule left before it would change
 * nothing, so it is not added.
 */
export function addRule(rules: readonly BadgeRule[], rule: BadgeRule): BadgeRule[] {
  const rest = rules.filter((r) => r.pattern !== rule.pattern);
  return rule.keep && !rest.some((r) => !r.keep) ? rest : [...rest, rule];
}

/** Rules read back from storage; malformed entries are dropped. */
export function parseRules(raw: unknown): BadgeRule[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r: unknown): BadgeRule[] => {
    if (typeof r !== 'object' || r === null) return [];
    const { pattern, keep } = r as Record<string, unknown>;
    return typeof pattern === 'string' && pattern !== '' && typeof keep === 'boolean' ? [{ pattern, keep }] : [];
  });
}

/**
 * A glob for refs named like `short`: its leading name before the first digit or separator, a
 * leading folder kept whole (IR-1.2.3 -> IR*, release/2026 -> release/*), else `short*`.
 */
export function similarPattern(short: string): string {
  const m = /^[^0-9\-_./]+\/?/.exec(short);
  return m && m[0] !== short ? `${m[0]}*` : `${short}*`;
}
