import { parseCssColor, toHex, type Rgb } from '../core/color.ts';
import { lanePalette } from '../core/palette.ts';

/** Colors and metrics the canvas needs; CSS handles everything else through variables. */
export interface GraphTheme {
  lanes: string[];
  foreground: string;
  /** Ring around the HEAD commit. */
  headRing: string;
  lineWidth: number;
  nodeRadius: number;
  highContrast: boolean;
}

const read = (style: CSSStyleDeclaration, name: string) => style.getPropertyValue(name).trim();

/**
 * Resolves graph colors from the VS Code theme variables currently applied to
 * the document. The lane palette is computed against the actual editor,
 * selection and hover backgrounds, so any theme gets readable lines.
 */
export function resolveGraphTheme(): GraphTheme {
  const style = getComputedStyle(document.documentElement);
  const highContrast =
    document.body.classList.contains('vscode-high-contrast') ||
    document.body.classList.contains('vscode-high-contrast-light');
  const bg = parseCssColor(read(style, '--vscode-editor-background')) ?? ([0, 0, 0] as Rgb);
  const surfaces = [
    '--vscode-list-activeSelectionBackground',
    '--vscode-list-inactiveSelectionBackground',
    '--vscode-list-hoverBackground',
  ]
    .map((v) => parseCssColor(read(style, v), bg))
    .filter((c): c is Rgb => c !== undefined);
  const fg = parseCssColor(read(style, '--vscode-foreground'), bg) ?? ([1, 1, 1] as Rgb);
  return {
    lanes: lanePalette({ background: bg, surfaces, minContrast: highContrast ? 4.5 : 3 }),
    foreground: toHex(fg),
    headRing: toHex(fg),
    lineWidth: highContrast ? 2 : 1.5,
    nodeRadius: highContrast ? 4 : 3.5,
    highContrast,
  };
}
