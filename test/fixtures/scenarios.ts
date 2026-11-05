import { execFileSync } from 'node:child_process';
import { RepoBuilder, type Mark } from './builder.ts';
import { addBranchyStashes } from './stashes.ts';

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
  b.commit('main', 'Add docs and sources', {
    files: {
      'docs/guide/intro.md': '# Intro\n',
      'docs/guide/setup.md': '# Setup\n',
      'docs/index.md': '# Docs\n',
      'src/app/main.ts': 'export {};\n',
      'NOTES.md': 'notes\n',
    },
  });
  b.commit('main', 'Release prep');
  return b;
}

/** branchy with five stashes; see addBranchyStashes. */
export function stashes(): RepoBuilder {
  return branchy().afterWrite(addBranchyStashes);
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

/**
 * Local branches with upstream ahead/behind (main tracks origin/main), annotated and lightweight
 * tags, several remotes, detached HEAD candidates.
 */
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
  // Pushed: the local branch and its remote-tracking branch on the same commit.
  b.ref('refs/remotes/origin/release/0.2', c3);
  b.remote('origin').remote('upstream');
  b.afterWrite((dir) =>
    execFileSync('git', ['branch', '--quiet', '--set-upstream-to=origin/main', 'main'], { cwd: dir }),
  );
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

/** Commit messages with bodies, trailers and a long explanation, as in kernel-style histories. */
export function messages(): RepoBuilder {
  const b = new RepoBuilder();
  b.commit('main', 'Initial import', { files: { 'driver.c': 'int probe(void) { return 0; }\n', README: 'driver\n' } });
  b.commit(
    'main',
    [
      'driver: fix use-after-free in remove path',
      '',
      'The remove callback freed the device state before the interrupt',
      'handler was unregistered, so an interrupt arriving in between read',
      'freed memory.',
      '',
      '\tfor (i = 1; i < symsec->sh_size / sizeof(Elf_Sym); i++) {',
      '\t\tconst char *name = info->strtab + sym[i].st_name;',
      '\t\t\t/* Divert to percpu allocation if a percpu variable. */',
      '',
      'Unregister the handler first and free the state last.',
      '',
      'Fixes: 1234567890ab ("driver: add remove callback")',
      'Signed-off-by: Ada Lovelace <ada@example.com>',
      'Change-Id: I8f2a6c1e0b9d4e7a3c5b1f0e2d4c6a8b9e1f3a5c',
    ].join('\n'),
    { files: { 'driver.c': 'int probe(void) { return 0; }\nvoid remove(void) {}\n' } },
  );
  b.commit('main', 'README: typo', { files: { README: 'Driver\n' } });
  b.commit(
    'main',
    [
      'driver: rework power management',
      '',
      ...Array.from(
        { length: 24 },
        (_, i) => `Step ${i + 1}: move part ${i + 1} of the suspend path into its own helper.`,
      ),
      '',
      'Signed-off-by: Ada Lovelace <ada@example.com>',
    ].join('\n'),
    {
      files: {
        'driver.c': 'int probe(void) { return 0; }\nvoid remove(void) {}\nint suspend(void) { return 0; }\n',
        'pm.c': 'int pm(void);\n',
      },
    },
  );
  b.commit(
    'main',
    [
      'docs(inventory): clarify hosts and inventory records across the ADRs and the hardware files',
      '',
      'Split host facts from hardware facts so each record has one owner, and repoint the',
      'ADRs that linked to the old combined pages.',
      '',
      'Signed-off-by: Ada Lovelace <ada@example.com>',
    ].join('\n'),
    {
      files: {
        'docs/adr/0008-wallpad-proxy-to-rpi2-shared-port.md': 'adr\n',
        'docs/adr/0018-pve-cluster-with-gen8-and-pfsense-ha.md': 'adr\n',
        'docs/adr/0021-move-dns-to-adguard-home.md': 'adr\n',
        'inventory/embedded-parts.md': 'host\n',
        'inventory/esxi.md': 'host\n',
        'inventory/gen8ubuntu.md': 'host\n',
        'inventory/GL-XE300.md': 'host\n',
        'inventory/GS116Ev2.md': 'host\n',
        'inventory/pfSense.md': 'host\n',
        'inventory/RaspberryPi2B.md': 'host\n',
        'inventory/rpi2.md': 'host\n',
        'inventory/U6-Pro.md': 'host\n',
        'inventory/what-runs-where.md': 'host\n',
        'docs/network/vlans.md': 'net\n',
        'docs/network/wifi.md': 'net\n',
        'docs/network/firewall-rules.md': 'net\n',
        'ops/pve3/victorialogs.yml': 'cfg\n',
        'ops/pve3/journal-upload.service': 'cfg\n',
        'README.md': 'homelab\n',
      },
    },
  );
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

/**
 * One file's history across branches: src/session.ts renamed to src/auth/session.ts, changed on
 * main, on a merged feature branch (resolved by hand in the merge), on an unmerged feature branch,
 * on a branch merged and deleted, and cherry-picked onto a release branch. The tips of main,
 * origin/main and feature/sso leave it unchanged.
 */
export function paths(): RepoBuilder {
  const b = new RepoBuilder();
  const mira = 'Mira Okafor <mira@example.com>';
  const jonas = 'Jonas Feld <jonas@example.com>';
  const priya = 'Priya Raman <priya@example.com>';
  const lena = 'Lena Wu <lena@example.com>';
  const session = (...lines: string[]) => `${lines.join('\n')}\n`;
  const v1 = ['export const ttl = 60;'];
  b.commit('main', 'Initial project layout', {
    author: mira,
    files: {
      'README.md': '# quillboard\n',
      'src/session.ts': session(...v1),
      'src/app.ts': 'app\n',
      'package.json': '{}\n',
    },
  });
  b.commit('main', 'Add routing', { author: jonas, files: { 'src/app.ts': 'app\nroutes\n' } });
  const v2 = [...v1, 'export function load() {}'];
  b.commit('main', 'Persist sessions in local storage', { author: mira, files: { 'src/session.ts': session(...v2) } });
  b.commit('main', 'Document local setup', { author: priya, files: { 'docs/setup.md': 'setup\n' } });
  b.commit('main', 'Move session handling under src/auth', {
    author: jonas,
    files: {
      'src/session.ts': null,
      'src/auth/session.ts': session(...v2),
      'src/auth/index.ts': "export * from './session';\n",
    },
  });
  const fork = b.commit('main', 'Header layout', { author: lena, files: { 'src/app.ts': 'app\nroutes\nheader\n' } });

  b.commit('feature/refresh-token', 'Refresh tokens before they expire', {
    parents: [fork],
    author: priya,
    files: { 'src/auth/session.ts': session(...v2, 'export function refresh() {}') },
  });
  b.commit('feature/refresh-token', 'Retry requests after refresh', {
    author: priya,
    files: { 'src/api/client.ts': 'retry\n' },
  });
  b.commit('feature/refresh-token', 'Add jitter to refresh timer', {
    author: priya,
    files: { 'src/auth/session.ts': session(...v2, 'export function refresh() {} // jitter') },
  });

  b.commit('main', 'Board view skeleton', { author: lena, files: { 'src/ui/board.ts': 'board\n' } });
  b.commit('main', 'Use seconds for session TTL', {
    author: mira,
    files: { 'src/auth/session.ts': session(...v2, 'export const ttlSeconds = 3600;') },
  });
  b.commit('main', 'Drag and drop cards', { author: lena, files: { 'src/ui/board.ts': 'board\ndnd\n' } });
  // Both sides changed the file; the resolution differs from each.
  const v3 = [...v2, 'export const ttlSeconds = 3600;', 'export function refresh() {} // jitter'];
  b.commit('main', "Merge branch 'feature/refresh-token'", {
    parents: [b.tip('main'), b.tip('feature/refresh-token')],
    author: mira,
    files: { 'src/auth/session.ts': session(...v3) },
  });
  const release = b.commit('main', 'Board columns', {
    author: lena,
    files: { 'src/ui/board.ts': 'board\ndnd\ncolumns\n' },
  });

  b.commit('feature/sso', 'SSO provider config', {
    parents: [release],
    author: jonas,
    files: { 'src/auth/sso.ts': 'sso\n' },
  });
  const sso = b.commit('feature/sso', 'Create sessions from SSO assertions', {
    author: jonas,
    files: { 'src/auth/session.ts': session(...v3, 'export function fromSso() {}') },
  });
  b.commit('feature/sso', 'SAML response parsing', { author: jonas, files: { 'src/auth/sso.ts': 'sso\nsaml\n' } });

  const theme = b.commit('main', 'Dark theme tokens', {
    parents: [release],
    author: lena,
    files: { 'src/ui/theme.ts': 'dark\n' },
  });
  const cleared = session(...v3, 'export function clear() {}');
  b.commit('fix/logout', 'Clear session on logout in every tab', {
    parents: [theme],
    author: priya,
    files: { 'src/auth/session.ts': cleared },
  });
  b.commit('main', 'High contrast tokens', { author: lena, files: { 'src/ui/theme.ts': 'dark\nhc\n' } });
  b.commit('main', "Merge branch 'fix/logout'", {
    parents: [b.tip('main'), b.tip('fix/logout')],
    author: mira,
    files: { 'src/auth/session.ts': cleared },
  });

  b.commit('release/2.x', 'Changelog for 2.1', {
    parents: [release],
    author: mira,
    files: { 'CHANGELOG.md': '2.1\n' },
  });
  const picked = b.commit('release/2.x', 'Clear session on logout in every tab', {
    author: priya,
    files: { 'src/auth/session.ts': cleared },
  });
  b.tag('v2.1.0', picked, 'Release 2.1.0');

  b.commit('main', 'Request timeouts', { author: jonas, files: { 'src/api/client.ts': 'timeouts\n' } });
  const nav = b.commit('main', 'Board keyboard navigation', {
    author: lena,
    files: { 'src/ui/board.ts': 'board\ndnd\ncolumns\na11y\n' },
  });
  b.commit('main', 'Bump dependencies', { author: priya, files: { 'package.json': '{"deps":1}\n' } });
  b.remote('origin');
  b.ref('refs/remotes/origin/main', nav);
  b.ref('refs/remotes/origin/feature/sso', sso);
  b.deleteRef('fix/logout');
  return b;
}

export const scenarios = {
  linear,
  branchy,
  stashes,
  octopus,
  'multi-root': multiRoot,
  refs,
  'clock-skew': clockSkew,
  messages,
  paths,
  large: () => large(),
} as const;

export type ScenarioName = keyof typeof scenarios;
