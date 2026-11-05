import { manifestCommands, manifestKeybindings, manifestMenus } from '../../src/shared/commands.ts';

interface Item {
  command: string;
}
interface Pkg {
  contributes: { commands: Item[]; menus: Record<string, Item[]>; keybindings?: Item[] };
}

/** Commands registered outside the table (src/extension.ts, src/host/entry.ts). */
const HAND_WRITTEN: ReadonlySet<string> = new Set([
  'strata.show',
  'strata.writeCommitGraph',
  'strata.switchRepository',
  'strata.openInGraph',
  'strata.showActive',
]);

/**
 * package.json text with the table's commands, menu items and key bindings replaced; other entries keep their
 * place. Any other strata.* entry is dropped: it belonged to a command the table no longer has.
 */
export function syncManifest(text: string): string {
  const pkg = JSON.parse(text) as Pkg;
  const keep = (items: Item[] | undefined) =>
    (items ?? []).filter((i) => !i.command.startsWith('strata.') || HAND_WRITTEN.has(i.command));
  pkg.contributes.commands = [...keep(pkg.contributes.commands), ...manifestCommands()];
  const keybindings = [...keep(pkg.contributes.keybindings), ...manifestKeybindings()];
  if (keybindings.length > 0) pkg.contributes.keybindings = keybindings;
  else Reflect.deleteProperty(pkg.contributes, 'keybindings');
  const menus: Partial<Record<string, Item[]>> = manifestMenus();
  for (const id of new Set([...Object.keys(pkg.contributes.menus), ...Object.keys(menus)])) {
    const all = [...keep(pkg.contributes.menus[id]), ...(menus[id] ?? [])];
    if (all.length > 0) pkg.contributes.menus[id] = all;
    else Reflect.deleteProperty(pkg.contributes.menus, id);
  }
  return `${JSON.stringify(pkg, null, 2)}\n`;
}
