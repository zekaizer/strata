/** Commands behind the graph's context menus (package.json: menus.webview/context). */
export const MENU_COMMANDS = [
  'strata.file.openChanges',
  'strata.file.openOld',
  'strata.file.openNew',
  'strata.file.openToSide',
  'strata.file.copyRelativePath',
  'strata.file.copyPath',
  'strata.file.copyOldRelativePath',
  'strata.commit.copyHash',
  'strata.commit.copyShortHash',
  'strata.commit.copySubject',
] as const;

export type MenuCommand = (typeof MENU_COMMANDS)[number];

export const isMenuCommand = (id: string): id is MenuCommand => (MENU_COMMANDS as readonly string[]).includes(id);
