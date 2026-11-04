/** User settings for test VS Code instances: a deterministic, uncluttered window. */
export const testSettings = {
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
  'window.restoreWindows': 'all',
  // VS Code's own context menus on Linux, which tests can close; 1.90 defaults to GTK menus there.
  'window.titleBarStyle': 'custom',
};
