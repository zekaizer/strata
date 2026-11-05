import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addRule,
  hiddenRefs,
  hidingRule,
  isPattern,
  matcher,
  parseRules,
  ruleCounts,
  similarPattern,
  type BadgeRule,
} from '../../src/core/badge-rules.ts';
import type { Ref, RefSnapshot } from '../../src/core/refs.ts';

const H = 'a'.repeat(40);
const ref = (kind: Ref['kind'], short: string): Ref => ({
  kind,
  short,
  name: `refs/${kind === 'branch' ? 'heads' : kind === 'remote' ? 'remotes' : 'tags'}/${short}`,
  hash: H,
});
const hide = (pattern: string): BadgeRule => ({ pattern, keep: false });
const keep = (pattern: string): BadgeRule => ({ pattern, keep: true });

describe('badge rule globs', () => {
  const matches = (pattern: string, short: string) => matcher(pattern)(short);

  it('lets * match any run of characters, slashes included', () => {
    assert.ok(matches('IR*', 'IR'));
    assert.ok(matches('IR*', 'IR-1.2.3'));
    assert.ok(matches('release/*', 'release/2026/q1'));
    assert.ok(matches('*/main', 'origin/main'));
    assert.ok(matches('*', 'anything/at/all'));
    assert.ok(!matches('IR*', 'xIR-1'));
  });
  it('lets ? match exactly one character', () => {
    assert.ok(matches('v?', 'v1'));
    assert.ok(matches('a?c', 'a/c'));
    assert.ok(!matches('v?', 'v'));
    assert.ok(!matches('v?', 'v10'));
  });
  it('takes every other character literally, regex characters included', () => {
    assert.ok(matches('v1.2', 'v1.2'));
    assert.ok(!matches('v1.2', 'v1x2'));
    assert.ok(matches('c++*', 'c++-17'));
    assert.ok(!matches('c++', 'cc'));
    assert.ok(matches('(x)|$^', '(x)|$^'));
    assert.ok(!matches('main', 'main2'));
  });
  it('is case-sensitive, like git', () => {
    assert.ok(!matches('ir*', 'IR-1'));
    assert.ok(!matches('Main', 'main'));
  });
  it('tells a pattern from a plain search', () => {
    assert.ok(isPattern('IR*'));
    assert.ok(isPattern('v?'));
    assert.ok(!isPattern('main'));
    assert.ok(!isPattern(''));
  });
});

describe('hidingRule', () => {
  it('lets the last matching rule decide', () => {
    const rules = [hide('IR*'), keep('IR*release*')];
    assert.deepEqual(hidingRule(rules, 'IR-1.2'), hide('IR*'));
    assert.equal(hidingRule(rules, 'IR-release-3'), undefined);
    assert.equal(hidingRule(rules, 'main'), undefined);
    assert.deepEqual(hidingRule([...rules, hide('IR-release-3')], 'IR-release-3'), hide('IR-release-3'));
  });
  it('shows a ref no rule matches', () => {
    assert.equal(hidingRule([], 'IR-1'), undefined);
    assert.equal(hidingRule([keep('*')], 'IR-1'), undefined);
  });
});

describe('hiddenRefs', () => {
  const snapshot = (refs: Ref[], headBranch: string | undefined): RefSnapshot => ({
    head: H,
    headBranch,
    refs,
    remotes: ['origin'],
    worktrees: [],
  });

  it('hides refs of every kind by short name, with the rule that hides them', () => {
    const refs = [ref('tag', 'IR-1'), ref('branch', 'IR-wip'), ref('remote', 'origin/IR-x'), ref('tag', 'v1')];
    const hidden = hiddenRefs([hide('IR*'), hide('origin/*')], snapshot(refs, 'main'));
    assert.deepEqual(
      [...hidden].map(([name, rule]) => `${name} ${rule.pattern}`),
      ['refs/tags/IR-1 IR*', 'refs/heads/IR-wip IR*', 'refs/remotes/origin/IR-x origin/*'],
    );
  });
  it('never hides the current branch', () => {
    const refs = [ref('branch', 'main'), ref('remote', 'origin/main'), ref('branch', 'dev')];
    const hidden = hiddenRefs([hide('*')], snapshot(refs, 'main'));
    assert.deepEqual([...hidden.keys()], ['refs/remotes/origin/main', 'refs/heads/dev']);
  });
  it('hides a branch named like the current one only when HEAD is elsewhere', () => {
    const refs = [ref('branch', 'main')];
    assert.equal(hiddenRefs([hide('main')], snapshot(refs, undefined)).size, 1);
  });
});

describe('ruleCounts', () => {
  it('counts the refs each rule is the last match of, the current branch aside', () => {
    const refs = [ref('tag', 'IR-1'), ref('tag', 'IR-release-1'), ref('tag', 'IR-2'), ref('branch', 'IR-main')];
    const snap: RefSnapshot = { head: H, headBranch: 'IR-main', refs, remotes: [], worktrees: [] };
    assert.deepEqual(ruleCounts([hide('IR*'), keep('IR*release*'), hide('v*')], snap), [2, 1, 0]);
  });
});

describe('addRule', () => {
  it('appends the rule and drops earlier rules of the same pattern, which it overrides', () => {
    assert.deepEqual(addRule([hide('IR*'), keep('IR-1'), hide('v*')], hide('IR-1')), [
      hide('IR*'),
      hide('v*'),
      hide('IR-1'),
    ]);
  });
  it('drops an exception nothing is left to hide', () => {
    assert.deepEqual(addRule([hide('IR-1')], keep('IR-1')), []);
    assert.deepEqual(addRule([hide('IR*'), hide('IR-1')], keep('IR-1')), [hide('IR*'), keep('IR-1')]);
  });
});

describe('parseRules', () => {
  it('keeps well-formed rules in order', () => {
    assert.deepEqual(parseRules([hide('IR*'), keep('IR*release*')]), [hide('IR*'), keep('IR*release*')]);
  });
  it('drops malformed entries and extra fields', () => {
    assert.deepEqual(
      parseRules([
        null,
        'IR*',
        { pattern: 'a' },
        { pattern: '', keep: false },
        { pattern: 1, keep: false },
        { pattern: 'b', keep: 'yes' },
        { pattern: 'c', keep: false, extra: 1 },
      ]),
      [hide('c')],
    );
  });
  it('reads anything that is not an array as no rules', () => {
    for (const raw of [undefined, null, {}, 'IR*', 3]) assert.deepEqual(parseRules(raw), []);
  });
});

describe('similarPattern', () => {
  it('keeps the leading name before the first digit or separator', () => {
    assert.equal(similarPattern('IR-1.2.3'), 'IR*');
    assert.equal(similarPattern('IR_20260101'), 'IR*');
    assert.equal(similarPattern('v1.0'), 'v*');
    assert.equal(similarPattern('nightly.5'), 'nightly*');
  });
  it('keeps a leading folder whole', () => {
    assert.equal(similarPattern('release/2026'), 'release/*');
    assert.equal(similarPattern('feature/login'), 'feature/*');
    assert.equal(similarPattern('origin/IR-1'), 'origin/*');
  });
  it('falls back to the whole name when nothing precedes a digit or separator, or nothing follows', () => {
    assert.equal(similarPattern('1.0'), '1.0*');
    assert.equal(similarPattern('main'), 'main*');
  });
});
