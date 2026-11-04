/**
 * Every command of the graph: its menus, palette and title-bar placement and whether it changes the
 * repository. package.json's command and menu contributions are generated from this table
 * (`npm run manifest`) and a unit test keeps them equal.
 */

/**
 * Elements that carry a data-vscode-context (src/shared/menu-context.ts): the `webviewSection` VS
 * Code matches menus against. `refs` is a "+N" badge.
 */
export type Section = 'commit' | 'stash' | 'branch' | 'remoteBranch' | 'tag' | 'head' | 'refs' | 'file';

/** The boolean context keys each section's element sets, which its menus' when-clauses may use. */
export const SECTION_KEYS: Record<Section, readonly string[]> = {
  commit: ['strataIsHead', 'strataMerge', 'strataHasRefs'],
  stash: ['strataLeftover'],
  branch: ['strataIsCurrent', 'strataUpstream'],
  remoteBranch: [],
  tag: [],
  head: [],
  refs: [],
  file: ['strataHasDiff', 'strataHasOld', 'strataHasNew', 'strataRenamed'],
};

export interface MenuPlacement {
  section: Section;
  /** `group@order` in the context menu. */
  group: string;
  /** Extra when-clause, using only SECTION_KEYS of `section`. */
  when?: string;
}

export interface CommandSpec {
  title: string;
  menus?: readonly MenuPlacement[];
  /** Shown in the command palette while the graph is the active editor (with this extra when-clause). */
  palette?: string | true;
  /** In the graph tab's title bar: an icon in `navigation`, or an overflow group. */
  titleBar?: { group: string; when?: string; icon?: string };
  /** Changes the repository: disabled while another operation runs. */
  writes?: true;
}

const file = (group: string, when?: string): MenuPlacement => ({ section: 'file', group, ...(when ? { when } : {}) });
const commit = (group: string, when?: string): MenuPlacement => ({
  section: 'commit',
  group,
  ...(when ? { when } : {}),
});

export const COMMANDS = {
  'strata.file.openChanges': { title: 'Open Changes', menus: [file('1_open@1', 'strataHasDiff')] },
  'strata.file.openOld': { title: 'Open Old Version (Before This Commit)', menus: [file('1_open@2', 'strataHasOld')] },
  'strata.file.openNew': { title: 'Open New Version (As of This Commit)', menus: [file('1_open@3', 'strataHasNew')] },
  'strata.file.openToSide': { title: 'Open to the Side', menus: [file('1_open@4')] },
  'strata.file.copyRelativePath': { title: 'Copy Relative Path', menus: [file('2_copy@1')] },
  'strata.file.copyPath': { title: 'Copy Path', menus: [file('2_copy@2')] },
  'strata.file.copyOldRelativePath': { title: 'Copy Old Relative Path', menus: [file('2_copy@3', 'strataRenamed')] },
  'strata.file.copyPatch': { title: 'Copy Patch', menus: [file('2_copy@4')] },

  'strata.commit.copyHash': { title: 'Copy Commit Hash', menus: [commit('5_copy@1')] },
  'strata.commit.copyShortHash': { title: 'Copy Short Commit Hash', menus: [commit('5_copy@2')] },
  'strata.commit.copySubject': { title: 'Copy Commit Subject', menus: [commit('5_copy@3')] },
  'strata.commit.copyPatch': { title: 'Copy Patch', menus: [commit('5_copy@4')] },

  'strata.undo': {
    title: 'Undo Last Operation',
    palette: 'strata.canUndo',
    titleBar: { group: '4_undo@1', when: 'strata.canUndo' },
    writes: true,
  },
  'strata.showOutput': { title: 'Show Git Output', palette: true, titleBar: { group: '9_output@1' } },

  // The banner's buttons (src/webview/banner.ts).
  'strata.operation.continue': { title: 'Continue Operation', writes: true },
  'strata.operation.abort': { title: 'Abort Operation...', writes: true },
  'strata.operation.skip': { title: 'Skip Commit...', writes: true },
  'strata.resolveConflicts': { title: 'Resolve Conflicts...' },
  'strata.stash.pop': { title: 'Pop Stash', writes: true },
  'strata.stash.drop': { title: 'Drop Stash...', writes: true },
  'strata.showStash': { title: 'Show Stash' },
  'strata.keepStash': { title: 'Keep Stash' },
} as const satisfies Record<string, CommandSpec>;

export type CommandId = keyof typeof COMMANDS;

export const COMMAND_IDS = Object.keys(COMMANDS) as CommandId[];

export const isCommandId = (id: string): id is CommandId => Object.hasOwn(COMMANDS, id);

/** Sections with at least one context menu item; VS Code opens no menu for the others. */
export const MENU_SECTIONS: ReadonlySet<string> = new Set(
  COMMAND_IDS.flatMap((id) => (COMMANDS[id] as CommandSpec).menus?.map((m) => m.section) ?? []),
);

const GRAPH = "webviewId == 'strata.graph'";
const ACTIVE = "activeWebviewPanelId == 'strata.graph'";

interface ManifestCommand {
  command: string;
  title: string;
  category: string;
  icon?: string;
  enablement?: string;
}
interface ManifestMenuItem {
  command: string;
  when: string;
  group?: string;
}

/** contributes.commands entries of the table's commands. */
export function manifestCommands(): ManifestCommand[] {
  return COMMAND_IDS.map((id) => {
    const spec: CommandSpec = COMMANDS[id];
    return {
      command: id,
      title: spec.title,
      category: 'Strata',
      ...(spec.titleBar?.icon ? { icon: spec.titleBar.icon } : {}),
      ...(spec.writes ? { enablement: '!strata.busy' } : {}),
    };
  });
}

/** contributes.menus entries of the table's commands, by menu id. */
export function manifestMenus(): Record<'webview/context' | 'editor/title' | 'commandPalette', ManifestMenuItem[]> {
  const context: ManifestMenuItem[] = [];
  const title: ManifestMenuItem[] = [];
  const palette: ManifestMenuItem[] = [];
  for (const id of COMMAND_IDS) {
    const spec: CommandSpec = COMMANDS[id];
    for (const m of spec.menus ?? [])
      context.push({
        command: id,
        when: [GRAPH, `webviewSection == '${m.section}'`, ...(m.when ? [m.when] : [])].join(' && '),
        group: m.group,
      });
    if (spec.titleBar)
      title.push({
        command: id,
        when: [ACTIVE, ...(spec.titleBar.when ? [spec.titleBar.when] : [])].join(' && '),
        group: spec.titleBar.group,
      });
    palette.push({
      command: id,
      when: spec.palette === undefined ? 'false' : spec.palette === true ? ACTIVE : `${ACTIVE} && ${spec.palette}`,
    });
  }
  return { 'webview/context': context, 'editor/title': title, commandPalette: palette };
}
