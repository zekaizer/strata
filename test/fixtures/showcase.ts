import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { EPOCH, RepoBuilder, type Mark } from './builder.ts';

const MIRA = 'Mira Okafor <mira@example.com>';
const TOMAS = 'Tomas Lindqvist <tomas.lindqvist@example.com>';
const PRIYA = 'Priya Raman <priya.raman@example.com>';
const JONAH = 'Jonah Weiss <jonah@example.com>';
const SOFIA = 'Sofia Marchetti <sofia.marchetti@example.com>';
const KENJI = 'Kenji Mori <kenji.mori@example.com>';

/** Builder time for a UTC wall-clock time such as `2026-10-05 09:14`. */
const at = (utc: string): number => Date.parse(`${utc.replace(' ', 'T')}:00Z`) / 1000 - EPOCH;

const deps: Record<string, string> = { express: '^4.19.2', react: '^18.2.0', 'react-dom': '^18.2.0' };
const devDeps: Record<string, string> = { typescript: '^5.5.4', vite: '^5.4.8', vitest: '^2.1.1' };

function pkg(version: string): Record<string, string> {
  const manifest = {
    name: 'quillboard',
    version,
    private: true,
    type: 'module',
    scripts: { dev: 'vite', build: 'vite build && tsc -p src/server', test: 'vitest run', lint: 'eslint .' },
    dependencies: deps,
    devDependencies: devDeps,
  };
  const lock = { name: 'quillboard', version, lockfileVersion: 3, packages: { '': manifest } };
  return {
    'package.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'package-lock.json': `${JSON.stringify(lock, null, 2)}\n`,
  };
}

function content(path: string, note: string): string {
  if (path.endsWith('.md')) return `# ${basename(path, '.md')}\n\n${note}.\n`;
  if (path.endsWith('.yml')) return `# ${note}\nname: ci\non: [push, pull_request]\n`;
  if (path.endsWith('.css')) return `/* ${note} */\n.board { display: grid; }\n`;
  if (path.endsWith('.json')) return `${JSON.stringify({ extends: '../tsconfig.base.json' }, null, 2)}\n`;
  if (path === '.gitignore') return 'node_modules/\ndist/\n';
  return `// ${note}\nexport {};\n`;
}

const files = (note: string, paths: string[]) => Object.fromEntries(paths.map((p) => [p, content(p, note)]));

/**
 * Five weeks of quillboard, an invented web app by six invented people: pull request merges,
 * release tags, a release branch merged back, a merged and an in-progress feature branch, and
 * main one commit ahead of origin/main. Only the README screenshot uses it.
 */
export function showcase(): RepoBuilder {
  const b = new RepoBuilder();
  const tips = new Map<string, Mark>();
  const parents = new Map<Mark, Mark[]>();
  const changes = new Map<Mark, Record<string, string>>();

  const add = (
    branch: string,
    message: string,
    when: string,
    author: string,
    ps: Mark[],
    files: Record<string, string>,
  ) => {
    const m = b.commit(branch, message, { parents: ps, time: at(when), author, files });
    tips.set(branch, m);
    parents.set(m, ps);
    changes.set(m, files);
    return m;
  };
  /** A commit on `branch`; a new branch forks from `from`, by default main's tip. */
  const commitFiles = (
    branch: string,
    when: string,
    author: string,
    message: string,
    files: Record<string, string>,
    from?: Mark,
  ): Mark => {
    const parent = from ?? tips.get(branch) ?? tips.get('main');
    return add(branch, message, when, author, parent === undefined ? [] : [parent], files);
  };
  const commit = (branch: string, when: string, author: string, message: string, ...paths: string[]) =>
    commitFiles(branch, when, author, message, files(message, paths));
  const ancestors = (m: Mark, seen = new Set<Mark>()): Set<Mark> => {
    if (!seen.has(m)) {
      seen.add(m);
      for (const p of parents.get(m)!) ancestors(p, seen);
    }
    return seen;
  };
  // The builder's merge keeps the first parent's version of paths both parents have; carry the merged side's changes over.
  const merge = (
    into: string,
    from: string,
    when: string,
    author: string,
    message: string,
    resolved: Record<string, string> = {},
  ) => {
    const ours = tips.get(into)!;
    const theirs = tips.get(from)!;
    const mine = ancestors(ours);
    const brought: Record<string, string> = {};
    for (const m of [...ancestors(theirs)].filter((x) => !mine.has(x)).sort((x, y) => x - y)) {
      Object.assign(brought, changes.get(m));
    }
    return add(into, message, when, author, [ours, theirs], { ...brought, ...resolved });
  };
  const pr = (n: number, branch: string, user: string, title: string) =>
    `Merge pull request #${n} from ${user}/${branch}\n\n${title}`;

  // Releases 1.2.x.
  commitFiles('main', '2026-09-28 09:12', MIRA, 'Import quillboard from the prototype repository', {
    ...pkg('1.1.0'),
    ...files('Initial import', [
      '.gitignore',
      'README.md',
      'CHANGELOG.md',
      'tsconfig.json',
      'vite.config.ts',
      'docs/architecture.md',
      'src/server/index.ts',
      'src/server/db.ts',
      'src/server/session.ts',
      'src/server/routes/boards.ts',
      'src/server/routes/notes.ts',
      'src/client/main.tsx',
      'src/client/App.tsx',
      'src/client/styles.css',
      'src/client/components/Board.tsx',
      'src/client/components/BoardHeader.tsx',
      'src/client/components/NoteCard.tsx',
      'src/client/components/ColorPicker.tsx',
      'tests/boards.test.ts',
      'tests/notes.test.ts',
    ]),
  });
  commit('main', '2026-09-28 11:40', JONAH, 'ci: run lint and tests on pull requests', '.github/workflows/ci.yml');
  commit(
    'main',
    '2026-09-28 16:25',
    PRIYA,
    'fix(server): reject notes longer than 10k characters',
    'src/server/routes/notes.ts',
    'tests/notes.test.ts',
  );
  commit(
    'main',
    '2026-09-29 10:03',
    TOMAS,
    'style: consistent spacing in note cards',
    'src/client/components/NoteCard.tsx',
    'src/client/styles.css',
  );
  const v120 = commitFiles('main', '2026-09-29 14:30', MIRA, 'chore(release): 1.2.0', {
    ...pkg('1.2.0'),
    'CHANGELOG.md': content('CHANGELOG.md', '1.2.0'),
  });
  b.tag('v1.2.0', v120, 'quillboard 1.2.0');

  commit(
    'feature/board-search',
    '2026-09-30 09:45',
    TOMAS,
    'feat(client): search box in the board header',
    'src/client/components/SearchBox.tsx',
    'src/client/components/BoardHeader.tsx',
  );
  commit('main', '2026-09-30 11:02', SOFIA, 'docs: document the REST API', 'docs/api.md');
  commit(
    'feature/board-search',
    '2026-09-30 13:20',
    TOMAS,
    'feat(server): full-text search over note bodies',
    'src/server/routes/search.ts',
    'src/server/db.ts',
  );
  deps['express'] = '^4.21.1';
  commitFiles('main', '2026-10-01 10:15', PRIYA, 'build(deps): bump express from 4.19.2 to 4.21.1', pkg('1.2.0'));
  commit(
    'main',
    '2026-10-01 11:30',
    PRIYA,
    'fix(client): keep the scroll position when a note is deleted',
    'src/client/components/Board.tsx',
  );
  const v121 = commitFiles('main', '2026-10-01 14:05', MIRA, 'chore(release): 1.2.1', {
    ...pkg('1.2.1'),
    'CHANGELOG.md': content('CHANGELOG.md', '1.2.1'),
  });
  b.tag('v1.2.1', v121, 'quillboard 1.2.1');
  commit(
    'feature/board-search',
    '2026-10-01 15:40',
    TOMAS,
    'test: search endpoint and ranking',
    'tests/search.test.ts',
  );
  merge(
    'main',
    'feature/board-search',
    '2026-10-01 17:05',
    MIRA,
    pr(12, 'feature/board-search', 'tlindqvist', 'Search notes across a board'),
  );

  // Release 1.3.0.
  commit(
    'fix/session-timeout',
    '2026-10-05 10:12',
    JONAH,
    'fix(server): refresh the session cookie on activity',
    'src/server/session.ts',
    'tests/session.test.ts',
  );
  merge(
    'main',
    'fix/session-timeout',
    '2026-10-05 16:40',
    MIRA,
    pr(15, 'fix/session-timeout', 'jweiss', 'Keep active sessions signed in'),
  );
  commit(
    'main',
    '2026-10-06 09:55',
    SOFIA,
    'refactor(client): move API calls into a typed client',
    'src/client/api.ts',
    'src/client/App.tsx',
    'src/client/components/Board.tsx',
  );
  commit('docs-typo', '2026-10-06 13:22', KENJI, 'Fix typos in the setup instructions', 'README.md');
  merge(
    'main',
    'docs-typo',
    '2026-10-06 15:08',
    SOFIA,
    pr(16, 'docs-typo', 'kmori', 'Fix typos in the setup instructions'),
  );
  deps['marked'] = '^14.1.2';
  deps['dompurify'] = '^3.1.7';
  commitFiles('feature/markdown-notes', '2026-10-07 10:30', PRIYA, 'feat(client): render note bodies as Markdown', {
    ...pkg('1.2.1'),
    'src/client/markdown.ts': content('src/client/markdown.ts', 'Markdown rendering'),
    'src/client/components/NoteCard.tsx': content('src/client/components/NoteCard.tsx', 'Markdown bodies'),
  });
  devDeps['vitest'] = '^2.1.4';
  commitFiles('main', '2026-10-07 11:45', JONAH, 'build(deps-dev): bump vitest from 2.1.1 to 2.1.4', pkg('1.2.1'));
  commit(
    'feature/markdown-notes',
    '2026-10-07 15:12',
    PRIYA,
    'fix: sanitize rendered Markdown',
    'src/client/markdown.ts',
    'tests/markdown.test.ts',
  );
  merge(
    'main',
    'feature/markdown-notes',
    '2026-10-08 10:05',
    MIRA,
    pr(17, 'feature/markdown-notes', 'priya-r', 'Markdown in note bodies'),
  );
  const v130 = commitFiles('main', '2026-10-08 13:40', MIRA, 'chore(release): 1.3.0', {
    ...pkg('1.3.0'),
    'CHANGELOG.md': content('CHANGELOG.md', '1.3.0'),
  });
  b.tag('v1.3.0', v130, 'quillboard 1.3.0');
  commit(
    'main',
    '2026-10-09 09:20',
    TOMAS,
    'Close the color picker on an outside click',
    'src/client/components/ColorPicker.tsx',
  );

  // Share links, with main merged in halfway.
  commit(
    'feature/share-links',
    '2026-10-12 10:02',
    SOFIA,
    'feat(server): signed read-only share links',
    'src/server/routes/share.ts',
    'src/server/tokens.ts',
    'src/server/index.ts',
  );
  commit('main', '2026-10-12 15:10', PRIYA, 'test: cover note reordering edge cases', 'tests/notes.test.ts');
  commit('main', '2026-10-13 09:48', JONAH, 'ci: cache npm downloads between runs', '.github/workflows/ci.yml');
  commit(
    'feature/share-links',
    '2026-10-13 11:27',
    SOFIA,
    'feat(client): share dialog with copy to clipboard',
    'src/client/components/ShareDialog.tsx',
    'src/client/components/BoardHeader.tsx',
    'src/client/styles.css',
  );
  merge('feature/share-links', 'main', '2026-10-14 10:15', SOFIA, "Merge branch 'main' into feature/share-links");
  commit(
    'feature/share-links',
    '2026-10-14 14:50',
    SOFIA,
    'docs: share links in the API reference',
    'docs/api.md',
    'docs/sharing.md',
  );
  commit(
    'feature/share-links',
    '2026-10-15 09:30',
    SOFIA,
    'test: share token expiry and revocation',
    'tests/share.test.ts',
  );
  merge(
    'main',
    'feature/share-links',
    '2026-10-15 16:22',
    MIRA,
    pr(21, 'feature/share-links', 'smarchetti', 'Read-only share links for boards'),
  );

  // Release 1.4 on its own branch.
  commit(
    'main',
    '2026-10-19 10:40',
    TOMAS,
    'perf(client): virtualize long boards',
    'src/client/components/Board.tsx',
    'src/client/hooks/useVirtualList.ts',
  );
  deps['react'] = '^18.3.1';
  deps['react-dom'] = '^18.3.1';
  commitFiles('main', '2026-10-19 15:05', PRIYA, 'build(deps): bump react and react-dom to 18.3.1', pkg('1.3.0'));
  commit(
    'fix/markdown-links',
    '2026-10-20 09:35',
    JONAH,
    'fix(client): open Markdown links in a new tab',
    'src/client/markdown.ts',
    'tests/markdown.test.ts',
  );
  const forkRelease = merge(
    'main',
    'fix/markdown-links',
    '2026-10-20 13:10',
    PRIYA,
    pr(24, 'fix/markdown-links', 'jweiss', 'Open Markdown links in a new tab'),
  );
  const rc1 = commitFiles(
    'release/1.4',
    '2026-10-21 11:00',
    MIRA,
    'chore(release): 1.4.0-rc.1',
    { ...pkg('1.4.0-rc.1'), 'CHANGELOG.md': content('CHANGELOG.md', '1.4.0-rc.1') },
    forkRelease,
  );
  b.tag('v1.4.0-rc.1', rc1, 'quillboard 1.4.0-rc.1');
  const forkSync = commit(
    'main',
    '2026-10-21 14:30',
    TOMAS,
    'feat(client): keyboard shortcuts for a new note and search',
    'src/client/shortcuts.ts',
    'src/client/App.tsx',
    'docs/shortcuts.md',
  );
  const forkTemplates = commit(
    'main',
    '2026-10-22 09:15',
    PRIYA,
    'fix(server): return 404 for archived boards',
    'src/server/routes/boards.ts',
    'tests/boards.test.ts',
  );
  commitFiles(
    'release/1.4',
    '2026-10-23 16:45',
    PRIYA,
    'fix(server): return 404 for archived boards',
    changes.get(forkTemplates)!,
  );
  commitFiles(
    'feature/offline-sync',
    '2026-10-26 10:10',
    TOMAS,
    'feat(client): queue edits while offline',
    files('offline queue', ['src/client/sync/queue.ts', 'src/client/api.ts']),
    forkSync,
  );
  commitFiles(
    'feature/board-templates',
    '2026-10-26 11:30',
    SOFIA,
    'feat: board templates for retrospectives and planning',
    files('board templates', [
      'src/server/templates.ts',
      'src/server/routes/templates.ts',
      'src/server/index.ts',
      'src/client/components/TemplatePicker.tsx',
      'src/client/components/NewBoardDialog.tsx',
      'src/client/api.ts',
    ]),
    forkTemplates,
  );
  commit(
    'feature/board-templates',
    '2026-10-27 10:05',
    SOFIA,
    'test: templates create their columns',
    'tests/templates.test.ts',
    'docs/templates.md',
  );
  merge(
    'main',
    'feature/board-templates',
    '2026-10-27 15:20',
    MIRA,
    pr(27, 'feature/board-templates', 'smarchetti', 'Board templates for retrospectives and planning'),
  );
  devDeps['vite'] = '^5.4.10';
  commitFiles('main', '2026-10-28 09:50', JONAH, 'build(deps-dev): bump vite from 5.4.8 to 5.4.10', pkg('1.3.0'));
  const pushedSync = tips.get('feature/offline-sync')!;
  commit(
    'feature/offline-sync',
    '2026-10-30 14:20',
    TOMAS,
    'WIP: replay queued edits on reconnect',
    'src/client/sync/replay.ts',
  );
  // The release branch's package.json predates the vite bump.
  merge('main', 'release/1.4', '2026-10-29 11:15', MIRA, "Merge branch 'release/1.4'", pkg('1.4.0-rc.1'));
  const pushed = commit(
    'main',
    '2026-10-29 16:30',
    PRIYA,
    'docs: refresh the README screenshots and setup steps',
    'README.md',
    'docs/setup.md',
  );
  commit('main', '2026-10-30 10:05', MIRA, 'chore: tidy the ESLint config', 'eslint.config.js');

  b.ref('refs/remotes/origin/main', pushed);
  b.ref('refs/remotes/origin/release/1.4', tips.get('release/1.4')!);
  b.ref('refs/remotes/origin/feature/offline-sync', pushedSync);
  b.remote('origin');
  b.afterWrite((dir) => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
    // Merged pull request branches are deleted, except the latest.
    git(
      'branch',
      '--quiet',
      '-D',
      ...[
        'feature/board-search',
        'fix/session-timeout',
        'docs-typo',
        'feature/markdown-notes',
        'feature/share-links',
        'fix/markdown-links',
      ],
    );
    git('branch', '--quiet', '--set-upstream-to=origin/main', 'main');
    git('branch', '--quiet', '--set-upstream-to=origin/release/1.4', 'release/1.4');
    git('branch', '--quiet', '--set-upstream-to=origin/feature/offline-sync', 'feature/offline-sync');
  });
  return b;
}
