// Single esbuild entry point for every bundle: extension host, webview, worker,
// integration tests and the webview playground.
import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const args = new Set(process.argv.slice(2));
const production = args.has('--production');
const watch = args.has('--watch');
const playground = args.has('--playground');
const once = args.has('--once');

// VS Code 1.90 ships Electron 29: Node 20.9, Chromium 122.
const NODE_TARGET = 'node20.9';
const WEB_TARGET = 'chrome122';

const common = {
  bundle: true,
  minify: production,
  sourcemap: production ? false : 'linked',
  logLevel: 'info',
  legalComments: 'none',
};

async function listTests(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile() && e.name.endsWith('.test.ts')) out.push(join(e.parentPath, e.name));
  }
  return out;
}

async function copyCodicons(outdir) {
  const src = 'node_modules/@vscode/codicons/dist';
  await mkdir(join(outdir, 'codicons'), { recursive: true });
  for (const f of ['codicon.css', 'codicon.ttf']) {
    await cp(join(src, f), join(outdir, 'codicons', f));
  }
}

const webviewOptions = (outdir) => [
  {
    ...common,
    entryPoints: { main: 'src/webview/main.ts', style: 'src/webview/main.css' },
    entryNames: '[name]',
    outdir,
    format: 'iife',
    platform: 'browser',
    target: WEB_TARGET,
  },
  {
    ...common,
    // The worker runs from a blob: URL, so a linked map's relative URL would not resolve.
    sourcemap: production ? false : 'inline',
    entryPoints: { worker: 'src/worker/main.ts' },
    outdir,
    format: 'iife',
    platform: 'browser',
    target: WEB_TARGET,
  },
];

// Every run starts from empty output directories so deleted sources (e.g. a
// removed test) cannot leave stale bundles behind.
const outDirs = playground ? ['out/playground'] : production ? ['dist'] : ['dist', 'out/test'];
await Promise.all(outDirs.map((d) => rm(d, { recursive: true, force: true })));

const configs = [];

if (playground) {
  const outdir = 'out/playground';
  configs.push(...webviewOptions(outdir), {
    ...common,
    entryPoints: { playground: 'playground/playground.ts' },
    outdir,
    format: 'iife',
    platform: 'browser',
    target: WEB_TARGET,
  });
  await copyCodicons(outdir);
  await cp('playground/index.html', join(outdir, 'index.html'));
  execFileSync(process.execPath, ['playground/data.ts'], { stdio: 'inherit' });
} else {
  configs.push(
    {
      ...common,
      entryPoints: ['src/extension.ts'],
      outfile: 'dist/extension.cjs',
      format: 'cjs',
      platform: 'node',
      target: NODE_TARGET,
      external: ['vscode'],
    },
    ...webviewOptions('dist/webview'),
  );
  if (!production) {
    configs.push({
      ...common,
      entryPoints: [
        ...(await listTests('test/integration')),
        ...(await listTests('test/perf')),
        ...(await listTests('test/multirepo')),
        ...(await listTests('test/readme')),
        'test/restart/driver.ts',
      ],
      outdir: 'out/test',
      outbase: 'test',
      outExtension: { '.js': '.cjs' },
      format: 'cjs',
      platform: 'node',
      target: NODE_TARGET,
      external: ['vscode', 'mocha'],
    });
  }
  await copyCodicons('dist/webview');
}

const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));

if (playground && !once) {
  await Promise.all(contexts.map((c) => c.watch()));
  const { hosts, port } = await contexts[0].serve({ servedir: 'out/playground', port: 5173 });
  console.log(`playground: http://${hosts[0] ?? 'localhost'}:${port}/`);
} else if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
