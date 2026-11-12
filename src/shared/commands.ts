/**
 * Every command of the graph: its menus, palette and title-bar placement and whether it changes the
 * repository. package.json's command and menu contributions are generated from this table
 * (`npm run manifest`) and a unit test keeps them equal.
 */

/**
 * Elements that carry a data-vscode-context (src/shared/menu-context.ts): the `webviewSection` VS
 * Code matches menus against. `refs` is a "+N" badge; `selection` a row of several selected commits.
 */
export type Section =
  | 'commit'
  | 'selection'
  | 'stash'
  | 'changes'
  | 'branch'
  | 'remoteBranch'
  | 'tag'
  | 'head'
  | 'refs'
  | 'worktree'
  | 'file';

/** The boolean context keys each section's element sets, which its menus' when-clauses may use. */
export const SECTION_KEYS: Record<Section, readonly string[]> = {
  commit: ['strataIsHead', 'strataHasRefs', 'strataBranch', 'strataRewritable', 'strataParentRewritable'],
  selection: [],
  stash: ['strataLeftover'],
  changes: [],
  branch: ['strataIsCurrent', 'strataUpstream', 'strataInWorktree'],
  remoteBranch: [],
  tag: [],
  head: [],
  refs: [],
  worktree: ['strataLocked', 'strataPrunable', 'strataMain', 'strataShown'],
  file: ['strataHasDiff', 'strataHasOld', 'strataHasNew', 'strataRenamed', 'strataInFolder'],
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
  /**
   * Changes the repository: disabled with a git too old to write (`strata.readOnly`), while
   * another operation runs, and while one is stopped
   * unless `whileStopped` (the ways out of a stop, and writes that leave HEAD, the index and the
   * work tree alone).
   */
  writes?: true | 'whileStopped';
  /** A key binding while the graph is the active editor: `key`, and `mac` on macOS. */
  key?: { key: string; mac: string };
}

const file = (group: string, when?: string): MenuPlacement => ({ section: 'file', group, ...(when ? { when } : {}) });
const commit = (group: string, when?: string): MenuPlacement => ({
  section: 'commit',
  group,
  ...(when ? { when } : {}),
});

/** Title-bar Pull and Push: on a branch with an upstream (`strata.head`), and no operation stopped. */
const SYNC = "!strata.operation && strata.head == 'tracking'";

export const COMMANDS = {
  'strata.file.openChanges': { title: 'Open Changes', menus: [file('1_open@1', 'strataHasDiff')] },
  'strata.file.openOld': { title: 'Open Old Version (Before This Commit)', menus: [file('1_open@2', 'strataHasOld')] },
  'strata.file.openNew': { title: 'Open New Version (As of This Commit)', menus: [file('1_open@3', 'strataHasNew')] },
  'strata.file.openToSide': { title: 'Open to the Side', menus: [file('1_open@4')] },
  'strata.file.copyRelativePath': { title: 'Copy Relative Path', menus: [file('2_copy@1')] },
  'strata.file.copyPath': { title: 'Copy Path', menus: [file('2_copy@2')] },
  'strata.file.copyOldRelativePath': { title: 'Copy Old Relative Path', menus: [file('2_copy@3', 'strataRenamed')] },
  'strata.file.copyPatch': { title: 'Copy Patch', menus: [file('2_copy@4')] },
  'strata.file.showHistory': { title: 'Show File History', menus: [file('3_history@1')] },
  'strata.file.showFolderHistory': { title: 'Show Folder History', menus: [file('3_history@2', 'strataInFolder')] },

  'strata.stash.push': {
    title: 'Stash Changes...',
    menus: [{ section: 'changes', group: '1_stash@1' }],
    palette: true,
    titleBar: { group: '1_stash@1' },
    writes: true,
  },
  'strata.stash.pushUntracked': {
    title: 'Stash Changes (Include Untracked)...',
    menus: [{ section: 'changes', group: '1_stash@2' }],
    palette: true,
    titleBar: { group: '1_stash@2' },
    writes: true,
  },
  'strata.checkout': {
    title: 'Checkout',
    menus: [
      commit('2_checkout@1', 'strataBranch'),
      { section: 'branch', group: '1_checkout@1', when: '!strataIsCurrent && !strataInWorktree' },
      { section: 'remoteBranch', group: '1_checkout@1' },
    ],
    writes: true,
  },
  'strata.checkoutDetached': {
    title: 'Checkout (Detached)',
    menus: [commit('2_checkout@2', '!strataIsHead'), { section: 'tag', group: '1_checkout@1' }],
    writes: true,
  },
  'strata.createBranch': {
    title: 'Create Branch...',
    menus: [commit('2_checkout@3'), { section: 'head', group: '1_checkout@1' }],
    writes: true,
  },
  'strata.createTag': { title: 'Create Tag...', menus: [commit('2_checkout@4')], writes: true },
  'strata.cherryPick': {
    title: 'Cherry Pick',
    menus: [commit('3_pick@1', '!strataIsHead'), { section: 'selection', group: '3_pick@1' }],
    writes: true,
  },
  'strata.revert': {
    title: 'Revert',
    menus: [commit('3_pick@2'), { section: 'selection', group: '3_pick@2' }],
    writes: true,
  },
  'strata.editMessage': {
    title: 'Edit Message...',
    menus: [commit('3_tidy@1', 'strataRewritable')],
    writes: true,
  },
  'strata.fixupIntoParent': {
    title: 'Fixup into Parent',
    menus: [commit('3_tidy@2', 'strataParentRewritable')],
    writes: true,
  },
  'strata.fixupIntoOlder': {
    title: 'Fixup into Older Commit...',
    menus: [commit('3_tidy@3', 'strataParentRewritable')],
    writes: true,
  },
  'strata.dropCommit': { title: 'Drop Commit...', menus: [commit('3_tidy@4', 'strataRewritable')], writes: true },
  'strata.squashSelected': {
    title: 'Squash Selected Commits...',
    menus: [{ section: 'selection', group: '1_tidy@1' }],
    writes: true,
  },
  'strata.dropSelected': {
    title: 'Drop Selected Commits...',
    menus: [{ section: 'selection', group: '1_tidy@2' }],
    writes: true,
  },
  'strata.copySelectedHashes': { title: 'Copy Commit Hashes', menus: [{ section: 'selection', group: '5_copy@1' }] },
  'strata.merge': {
    title: 'Merge into Current Branch...',
    menus: [
      commit('4_integrate@1', '!strataIsHead'),
      { section: 'branch', group: '2_apply@1', when: '!strataIsCurrent' },
      { section: 'remoteBranch', group: '2_apply@1' },
    ],
    writes: true,
  },
  'strata.rebase': {
    title: 'Rebase Current Branch onto This...',
    menus: [
      commit('4_integrate@2', '!strataIsHead'),
      { section: 'branch', group: '2_apply@2', when: '!strataIsCurrent' },
      { section: 'remoteBranch', group: '2_apply@2' },
    ],
    writes: true,
  },
  'strata.commit.copyHash': { title: 'Copy Commit Hash', menus: [commit('5_copy@1')] },
  'strata.commit.copyShortHash': { title: 'Copy Short Commit Hash', menus: [commit('5_copy@2')] },
  'strata.commit.copySubject': { title: 'Copy Commit Subject', menus: [commit('5_copy@3')] },
  'strata.commit.copyPatch': { title: 'Copy Patch', menus: [commit('5_copy@4')] },
  'strata.refActions': {
    title: 'Branch and Tag Actions...',
    menus: [commit('2_checkout@5', 'strataHasRefs'), { section: 'refs', group: '1_refs@1' }],
  },
  'strata.reset': {
    title: 'Reset Current Branch to Here...',
    menus: [commit('9_reset@1', '!strataIsHead')],
    writes: true,
  },

  'strata.push': {
    title: 'Push',
    menus: [{ section: 'branch', group: '3_remote@2', when: 'strataUpstream' }],
    palette: true,
    titleBar: { group: 'navigation@5', when: SYNC, icon: '$(repo-push)' },
    writes: true,
  },
  'strata.publish': {
    title: 'Publish Branch...',
    menus: [{ section: 'branch', group: '3_remote@2', when: '!strataUpstream' }],
    palette: "strata.head == 'branch'",
    titleBar: { group: 'navigation@5', when: "!strata.operation && strata.head == 'branch'", icon: '$(cloud-upload)' },
    writes: true,
  },
  'strata.setUpstream': {
    title: 'Set Upstream...',
    menus: [{ section: 'branch', group: '3_remote@3' }],
    writes: true,
  },
  'strata.pull': {
    title: 'Pull',
    // Another worktree's branch: moving it would leave that worktree's HEAD ahead of its files.
    menus: [{ section: 'branch', group: '3_remote@1', when: 'strataUpstream && !strataInWorktree' }],
    palette: true,
    titleBar: { group: 'navigation@4', when: SYNC, icon: '$(repo-pull)' },
    writes: true,
  },
  'strata.fetch': {
    title: 'Fetch From All Remotes',
    palette: true,
    titleBar: { group: 'navigation@3', icon: '$(repo-fetch)' },
    writes: 'whileStopped',
  },
  'strata.fetchRemote': {
    title: 'Fetch Remote',
    menus: [{ section: 'remoteBranch', group: '3_remote@1' }],
    writes: 'whileStopped',
  },
  'strata.pushTag': { title: 'Push Tag...', menus: [{ section: 'tag', group: '3_remote@1' }], writes: true },
  'strata.renameBranch': {
    title: 'Rename Branch...',
    menus: [{ section: 'branch', group: '4_edit@1', when: '!strataInWorktree' }],
    writes: true,
  },
  'strata.copyRefName': {
    title: 'Copy Name',
    menus: [
      { section: 'branch', group: '4_edit@2' },
      { section: 'remoteBranch', group: '5_copy@1' },
      { section: 'tag', group: '5_copy@1' },
    ],
  },
  'strata.hideBadge': {
    title: 'Hide Badge',
    menus: [
      { section: 'branch', group: '6_hide@1', when: '!strataIsCurrent && !strataInWorktree' },
      { section: 'remoteBranch', group: '6_hide@1' },
      { section: 'tag', group: '6_hide@1' },
    ],
  },
  'strata.hideSimilarBadges': {
    title: 'Hide Similar Badges...',
    menus: [
      { section: 'branch', group: '6_hide@2', when: '!strataIsCurrent && !strataInWorktree' },
      { section: 'remoteBranch', group: '6_hide@2' },
      { section: 'tag', group: '6_hide@2' },
    ],
  },
  'strata.deleteBranch': {
    title: 'Delete Branch...',
    menus: [{ section: 'branch', group: '9_delete@1', when: '!strataIsCurrent && !strataInWorktree' }],
    writes: true,
  },
  'strata.deleteTag': { title: 'Delete Tag...', menus: [{ section: 'tag', group: '9_delete@1' }], writes: true },
  'strata.deleteRemoteTag': {
    title: 'Delete Remote Tag...',
    menus: [{ section: 'tag', group: '9_delete@2' }],
    writes: true,
  },
  'strata.deleteRemoteBranch': {
    title: 'Delete Remote Branch...',
    menus: [{ section: 'remoteBranch', group: '9_delete@1' }],
    writes: true,
  },

  /** Another worktree (its part in a branch's badge, or its badge on a detached HEAD). */
  'strata.worktree.show': {
    title: 'Show Worktree in Graph',
    menus: [{ section: 'worktree', group: '1_open@1', when: 'strataShown' }],
  },
  'strata.worktree.openNewWindow': {
    title: 'Open Worktree in New Window',
    menus: [{ section: 'worktree', group: '1_open@2', when: '!strataPrunable' }],
  },
  'strata.worktree.openCurrentWindow': {
    title: 'Open Worktree in Current Window',
    menus: [{ section: 'worktree', group: '1_open@3', when: '!strataPrunable' }],
  },
  // A remote window's file explorer is on another machine.
  'strata.worktree.reveal': {
    title: 'Reveal Worktree in File Explorer',
    menus: [{ section: 'worktree', group: '2_copy@1', when: '!strataPrunable && !remoteName' }],
  },
  'strata.worktree.copyPath': { title: 'Copy Worktree Path', menus: [{ section: 'worktree', group: '2_copy@2' }] },
  'strata.worktree.remove': {
    title: 'Remove Worktree...',
    menus: [{ section: 'worktree', group: '9_remove@1', when: '!strataMain && !strataPrunable' }],
    writes: 'whileStopped',
  },
  'strata.worktree.prune': {
    title: 'Prune Worktrees',
    menus: [{ section: 'worktree', group: '9_remove@1', when: 'strataPrunable' }],
    writes: 'whileStopped',
  },

  'strata.operation.continue': {
    title: 'Continue Operation',
    palette: 'strata.operation',
    titleBar: { group: 'navigation@1', when: 'strata.operation', icon: '$(check)' },
    writes: 'whileStopped',
  },
  'strata.operation.abort': {
    title: 'Abort Operation...',
    palette: 'strata.operation',
    titleBar: { group: 'navigation@2', when: 'strata.operation', icon: '$(discard)' },
    writes: 'whileStopped',
  },
  'strata.operation.skip': {
    title: 'Skip Commit...',
    palette: "strata.operation && strata.operation != 'merge'",
    titleBar: { group: '2_operation@1', when: "strata.operation && strata.operation != 'merge'" },
    writes: 'whileStopped',
  },
  'strata.stash.apply': {
    title: 'Apply Stash',
    menus: [{ section: 'stash', group: '1_apply@1', when: '!strataLeftover' }],
    writes: true,
  },
  'strata.stash.pop': {
    title: 'Pop Stash',
    menus: [{ section: 'stash', group: '1_apply@2', when: '!strataLeftover' }],
    writes: true,
  },
  'strata.stash.branch': {
    title: 'Create Branch from Stash...',
    menus: [{ section: 'stash', group: '1_apply@3' }],
    writes: true,
  },
  'strata.stash.copyPatch': { title: 'Copy Patch', menus: [{ section: 'stash', group: '5_copy@1' }] },
  'strata.stash.drop': { title: 'Drop Stash...', menus: [{ section: 'stash', group: '9_delete@1' }], writes: true },
  'strata.openScm': { title: 'Open Source Control', menus: [{ section: 'changes', group: '2_scm@1' }] },
  'strata.showStashes': { title: 'Show Stashes...', palette: true, titleBar: { group: '1_stash@3' } },
  'strata.goToHead': { title: 'Go to HEAD', palette: true },
  /** The graph handles Ctrl+F itself while it has focus; the key binding covers the rest of its tab. */
  'strata.find': { title: 'Find Commit...', palette: true, key: { key: 'ctrl+f', mac: 'cmd+f' } },

  /** Save in the inline message editor (menuCommand); the editor stays open unless it was applied. */
  'strata.saveEdit': { title: 'Save Commit Message' },
  /** Banner buttons (menuCommand): resolve conflicts, show or keep a leftover stash. */
  'strata.resolveConflicts': { title: 'Resolve Conflicts...' },
  'strata.showStash': { title: 'Show Stash' },
  'strata.keepStash': { title: 'Keep Stash' },
  'strata.undo': {
    title: 'Undo Last Operation',
    palette: 'strata.canUndo',
    // Not while an operation is stopped: Abort shows the same icon then, and Undo is disabled.
    titleBar: { group: 'navigation@6', when: 'strata.canUndo && !strata.operation', icon: '$(discard)' },
    writes: true,
  },
  'strata.showOutput': { title: 'Show Git Output', palette: true, titleBar: { group: '9_output@1' } },
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
      ...(spec.writes
        ? {
            enablement: `!strata.readOnly && !strata.busy${spec.writes === 'whileStopped' ? '' : ' && !strata.operation'}`,
          }
        : {}),
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

interface ManifestKeybinding {
  command: string;
  key: string;
  mac: string;
  when: string;
}

/** contributes.keybindings entries of the table's commands. */
export function manifestKeybindings(): ManifestKeybinding[] {
  return COMMAND_IDS.flatMap((id) => {
    const key = (COMMANDS[id] as CommandSpec).key;
    return key ? [{ command: id, ...key, when: ACTIVE }] : [];
  });
}

/** Evaluates a menu's extra when-clause (`flag && !flag`, the only form the table uses) against a context's flags. */
export function whenHolds(when: string | undefined, flags: Readonly<Record<string, unknown>>): boolean {
  if (when === undefined) return true;
  return when.split('&&').every((term) => {
    const t = term.trim();
    return t.startsWith('!') ? !flags[t.slice(1)] : Boolean(flags[t]);
  });
}

/** `group@order` as VS Code sorts menu items. */
const position = (group: string): [string, number] => {
  const [name = '', order = '0'] = group.split('@');
  return [name, Number(order)];
};

/**
 * The commands a badge's context menu shows for a ref of `section` with these flags, in menu
 * order: what Branch and Tag Actions... offers for keyboard users, evaluated from the same table.
 */
export function refActions(section: Section, flags: Readonly<Record<string, unknown>>): CommandId[] {
  const found: { id: CommandId; at: [string, number] }[] = [];
  for (const id of COMMAND_IDS) {
    const spec: CommandSpec = COMMANDS[id];
    const m = spec.menus?.find((p) => p.section === section && whenHolds(p.when, flags));
    if (m) found.push({ id, at: position(m.group) });
  }
  return found.sort((a, b) => a.at[0].localeCompare(b.at[0]) || a.at[1] - b.at[1]).map((f) => f.id);
}
