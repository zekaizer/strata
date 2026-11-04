import { COMMAND_IDS, manifestCommands, manifestMenus } from '../../src/shared/commands.ts';

interface Item {
  command: string;
}
interface Pkg {
  contributes: { commands: Item[]; menus: Record<string, Item[]> };
}

/** package.json text with the table's commands and menu items replaced; other entries keep their place. */
export function syncManifest(text: string): string {
  const pkg = JSON.parse(text) as Pkg;
  const ours = new Set<string>(COMMAND_IDS);
  const keep = (items: Item[] | undefined) => (items ?? []).filter((i) => !ours.has(i.command));
  pkg.contributes.commands = [...keep(pkg.contributes.commands), ...manifestCommands()];
  const menus = manifestMenus();
  for (const [id, items] of Object.entries(menus)) {
    const all = [...keep(pkg.contributes.menus[id]), ...items];
    if (all.length > 0) pkg.contributes.menus[id] = all;
    else Reflect.deleteProperty(pkg.contributes.menus, id);
  }
  return `${JSON.stringify(pkg, null, 2)}\n`;
}
