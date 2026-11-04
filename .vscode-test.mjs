import { defineConfig } from '@vscode/test-cli';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { userDataDir } from './scripts/lib/test-paths.ts';
import { scenarios } from './test/fixtures/scenarios.ts';

// Integration tests open the deterministic `branchy` fixture repository.
const workspace = join(import.meta.dirname, 'out', 'fixtures', 'branchy');
scenarios.branchy().write(workspace);

// Deterministic, uncluttered window for tests and screenshots.
const settings = {
  'workbench.startupEditor': 'none',
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'workbench.tips.enabled': false,
  'chat.disableAIFeatures': true,
  'git.openRepositoryInParentFolders': 'never',
  'extensions.ignoreRecommendations': true,
  'security.workspace.trust.enabled': false,
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'window.newWindowDimensions': 'maximized',
};

const launchArgs = (label) => {
  const dir = userDataDir(label);
  mkdirSync(join(dir, 'User'), { recursive: true });
  writeFileSync(join(dir, 'User', 'settings.json'), JSON.stringify(settings, null, 2));
  return [
    `--user-data-dir=${dir}`,
    '--disable-extensions',
    '--disable-gpu',
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    // Chromium refuses to start as root without this (containers, CI).
    ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
  ];
};

const base = {
  files: 'out/test/integration/**/*.test.cjs',
  workspaceFolder: workspace,
  mocha: { ui: 'bdd', timeout: 60_000 },
};

export default defineConfig([
  { ...base, label: 'stable', version: 'stable', launchArgs: launchArgs('stable') },
  { ...base, label: 'min', version: '1.90.0', launchArgs: launchArgs('min') },
]);
