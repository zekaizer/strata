import { manifestCommands, manifestMenus } from '../../src/shared/commands.ts';

interface Item {
  command: string;
}
interface Pkg {
  contributes: { commands: Item[]; menus: Record<string, Item[]> };
}

/** Commands src/extension.ts registers itself, outside the table. */
const HAND_WRITTEN: ReadonlySet<string> = new Set(['strata.show', 'strata.writeCommitGraph']);

/**
 * package.json text with the table's commands and menu items replaced; other entries keep their
 * place. Any other strata.* entry is dropped: it belonged to a command the table no longer has.
 */
export function syncManifest(text: string): string {
  const pkg = JSON.parse(text) as Pkg;
  const keep = (items: Item[] | undefined) =>
    (items ?? []).filter((i) => !i.command.startsWith('strata.') || HAND_WRITTEN.has(i.command));
  pkg.contributes.commands = [...keep(pkg.contributes.commands), ...manifestCommands()];
  const menus: Partial<Record<string, Item[]>> = manifestMenus();
  for (const id of new Set([...Object.keys(pkg.contributes.menus), ...Object.keys(menus)])) {
    const all = [...keep(pkg.contributes.menus[id]), ...(menus[id] ?? [])];
    if (all.length > 0) pkg.contributes.menus[id] = all;
    else Reflect.deleteProperty(pkg.contributes.menus, id);
  }
  return `${JSON.stringify(pkg, null, 2)}\n`;
}
