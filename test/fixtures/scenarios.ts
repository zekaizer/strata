import { RepoBuilder, type Mark } from './builder.ts';

/** 30 commits on main. */
export function linear(): RepoBuilder {
  const b = new RepoBuilder();
  for (let i = 1; i <= 30; i++) b.commit('main', `Linear commit ${i}`);
  return b;
}

/**
 * Feature branches forking and merging, an unmerged branch, a criss-cross
 * merge and a branch merged twice.
 */
export function branchy(): RepoBuilder {
  const b = new RepoBuilder();
  const base = b.commit('main', 'Initial commit');
  b.commit('main', 'Add build');

  b.commit('feature/login', 'Login form', { parents: [base] });
  b.commit('feature/login', 'Login validation');
  b.commit('main', 'Fix typo');
  b.merge('main', [b.tip('feature/login')], 'Merge branch feature/login');

  const fork = b.commit('main', 'Refactor config');
  b.commit('feature/search', 'Search index', { parents: [fork] });
  b.commit('wip/experiment', 'Unmerged experiment', { parents: [fork] });
  b.commit('main', 'Bump version');
  b.commit('feature/search', 'Search UI');
  b.merge('feature/search', [b.tip('main')], 'Merge main into feature/search');
  b.commit('feature/search', 'Search ranking');
  b.merge('main', [b.tip('feature/search')], 'Merge branch feature/search');

  // Criss-cross: x and y each merge the other's previous tip.
  const cc = b.commit('main', 'Prepare criss-cross');
  const x1 = b.commit('cross/x', 'X1', { parents: [cc] });
  const y1 = b.commit('cross/y', 'Y1', { parents: [cc] });
  b.commit('cross/x', 'Merge y into x', { parents: [x1, y1] });
  b.commit('cross/y', 'Merge x into y', { parents: [y1, x1] });
  b.merge('main', [b.tip('cross/x'), b.tip('cross/y')], 'Merge cross/x and cross/y');
  b.commit('main', 'Release prep');
  return b;
}

/** Octopus merges with 4 and 5 parents (main tip + topics); one topic tip is itself a merge. */
export function octopus(): RepoBuilder {
  const b = new RepoBuilder();
  const base = b.commit('main', 'Base');
  const heads: Mark[] = [];
  for (const n of ['a', 'b', 'c']) {
    b.commit(`topic/${n}`, `Topic ${n} 1`, { parents: [base] });
    heads.push(b.commit(`topic/${n}`, `Topic ${n} 2`));
  }
  b.merge('main', heads, 'Octopus merge of 3 topics');
  const base2 = b.commit('main', 'After first octopus');
  const heads2: Mark[] = [];
  for (const n of ['d', 'e', 'f', 'g']) heads2.push(b.commit(`topic/${n}`, `Topic ${n}`, { parents: [base2] }));
  b.merge('topic/g', [heads2[0]!], 'Merge d into g');
  heads2[3] = b.tip('topic/g');
  b.merge('main', heads2, 'Octopus merge of 4 topics');
  b.commit('main', 'Tip');
  return b;
}

/** Three root commits: two histories merged with --allow-unrelated-histories, one orphan left unmerged. */
export function multiRoot(): RepoBuilder {
  const b = new RepoBuilder();
  b.commit('main', 'Root A');
  b.commit('main', 'A2');
  b.commit('import', 'Root B (imported project)', { parents: [] });
  b.commit('import', 'B2');
  b.merge('main', [b.tip('import')], 'Merge unrelated history import');
  b.commit('main', 'A3');
  b.commit('gh-pages', 'Root C (orphan docs branch)', { parents: [] });
  b.commit('gh-pages', 'Docs update');
  return b;
}

/** Local branches with upstream ahead/behind, annotated and lightweight tags, several remotes, detached HEAD candidates. */
export function refs(): RepoBuilder {
  const b = new RepoBuilder();
  const c1 = b.commit('main', 'C1');
  b.tag('v0.1.0', c1, 'Release 0.1.0');
  const c2 = b.commit('main', 'C2');
  b.tag('lightweight-tag', c2);
  const c3 = b.commit('main', 'C3');
  b.ref('refs/remotes/origin/main', c3);
  b.ref('refs/remotes/origin/HEAD', c3);
  b.commit('main', 'C4 local only');
  b.commit('main', 'C5 local only');
  b.ref('refs/remotes/upstream/main', c2);
  const d1 = b.commit('refs/remotes/origin/develop', 'D1 remote only', { parents: [c3] });
  b.commit('develop', 'D2 local develop', { parents: [d1] });
  b.tag('v0.2.0', c3, 'Release 0.2.0');
  b.tag('v0.2.0-rc1', c3, 'Release candidate');
  b.ref('release/0.2', c3);
  return b;
}

/** Committer dates that go backwards: children older than parents (rebases, bad clocks). */
export function clockSkew(): RepoBuilder {
  const b = new RepoBuilder();
  const a = b.commit('main', 'A', { time: 10_000 });
  b.commit('main', 'B (clock behind)', { time: 5_000 });
  b.commit('side', 'S1 (far future)', { parents: [a], time: 90_000 });
  b.commit('main', 'C', { time: 6_000 });
  b.merge('main', [b.tip('side')], 'Merge side');
  return b;
}

/** Mulberry32: tiny seeded PRNG so large fixtures are reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `count` commits of randomized but reproducible history: concurrent branches,
 * forks, merges, occasional octopus merges and an extra root. Used for
 * pagination and incremental layout tests.
 */
export function large(count = 5000, seed = 1): RepoBuilder {
  const r = rng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const b = new RepoBuilder();
  b.commit('main', 'Large root');
  const active = new Set<string>(['main']);
  let next = 0;
  let made = 1;
  const files = (name: string) => ({ [`f${made % 64}.txt`]: `${name}\n` });
  while (made < count) {
    const x = r();
    if (x < 0.08 && active.size < 12) {
      const name = `b${next++}`;
      b.commit(name, `Fork ${name}`, { parents: [b.tip(pick([...active]))], files: files(name) });
      active.add(name);
    } else if (x < 0.18 && active.size > 1) {
      const into = pick([...active]);
      const others = [...active].filter((n) => n !== into);
      const octo = r() < 0.1 && others.length >= 3;
      const from = octo ? others.slice(0, 3) : [pick(others)];
      b.commit(into, `Merge ${from.join(', ')} into ${into}`, {
        parents: [b.tip(into), ...from.map((n) => b.tip(n))],
        files: files(into),
      });
      for (const n of from) if (n !== 'main' && r() < 0.7) active.delete(n);
    } else if (x < 0.181) {
      const name = `root${next++}`;
      b.commit(name, `Extra root ${name}`, { parents: [], files: files(name) });
      active.add(name);
    } else {
      const on = pick([...active]);
      b.commit(on, `Work on ${on} #${made}`, { files: files(on) });
    }
    made++;
  }
  return b;
}

export const scenarios = {
  linear,
  branchy,
  octopus,
  'multi-root': multiRoot,
  refs,
  'clock-skew': clockSkew,
  large: () => large(),
} as const;

export type ScenarioName = keyof typeof scenarios;
