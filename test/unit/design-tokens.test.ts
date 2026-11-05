// Keeps the webview's stylesheets on the design system (docs/design-system.md): raw colors, radii,
// font sizes, spacing and z-indexes belong in src/webview/tokens.css only.
import * as assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const WEBVIEW = join(import.meta.dirname, '..', '..', 'src', 'webview');
const TOKENS = 'tokens.css';

/**
 * Declarations that may keep a raw value, each with its reason: `file`, the declaration as
 * written (`property: value`), and why no token fits.
 */
const ALLOWED: readonly { file: string; declaration: string; reason: string }[] = [
  {
    file: 'main.css',
    declaration:
      'padding: var(--space-8) var(--space-12) var(--space-12) calc(var(--graph-width, 40px) + var(--col-gap))',
    reason: 'graph geometry: the graph column width main.ts sets, with a fallback until it does',
  },
];

/** Properties that space things out; their lengths come from the --space-* scale (1px hairlines aside). */
const SPACING =
  /^(margin|padding)(-(top|right|bottom|left|block|inline)(-(start|end))?)?$|^(gap|row-gap|column-gap|inset|top|right|bottom|left)$/;

const NAMED_COLORS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown ' +
    'burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan ' +
    'darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid ' +
    'darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet ' +
    'deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ' +
    'ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
    'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow ' +
    'lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray ' +
    'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine ' +
    'mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise ' +
    'mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab ' +
    'orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru ' +
    'pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown ' +
    'seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan ' +
    'teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'
  ).split(' '),
);

interface Violation {
  line: number;
  declaration: string;
  rule: string;
}

/** Raw values in `css` that must come from tokens. */
function violations(css: string): Violation[] {
  // Comments become spaces of the same length, so offsets still give line numbers.
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const found: Violation[] = [];
  // Innermost blocks hold declarations (rules, and keyframe steps).
  for (const block of text.matchAll(/\{([^{}]*)\}/g)) {
    let offset = block.index + 1;
    for (const part of block[1]!.split(';')) {
      const at = offset;
      offset += part.length + 1;
      const colon = part.indexOf(':');
      if (colon < 0) continue;
      const property = part.slice(0, colon).trim().toLowerCase();
      if (property.startsWith('--')) continue;
      const value = part.slice(colon + 1).trim();
      const line = text.slice(0, at + part.length - part.trimStart().length).split('\n').length;
      const declaration = `${property}: ${value.replace(/\s+/g, ' ')}`;
      // Strings and custom property names may say anything.
      const bare = value.replace(/'[^']*'|"[^"]*"/g, '').replace(/--[\w-]+/g, '');
      const flag = (rule: string) => found.push({ line, declaration, rule });
      if (/#[0-9a-f]{3,8}\b/i.test(bare)) flag('hex color');
      if (/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i.test(bare)) flag('color function');
      for (const word of bare.toLowerCase().match(/[a-z]+/g) ?? []) if (NAMED_COLORS.has(word)) flag('named color');
      const length = /\d(px|em|rem|pt|%)/.test(bare);
      if (/^border(-[a-z]+)*-radius$/.test(property) && length) flag('raw radius');
      if ((property === 'font-size' || property === 'font') && length) flag('raw font size');
      if (property === 'z-index' && /\d/.test(bare)) flag('raw z-index');
      if (SPACING.test(property) && [...bare.matchAll(/(\d*\.?\d+)(px|em|rem)/g)].some((m) => m[0] !== '1px'))
        flag('raw spacing');
    }
  }
  return found;
}

describe('design tokens', () => {
  it('flags raw colors, radii, font sizes and layers', () => {
    const css = [
      '.a { color: #fff; background: rgb(0 0 0 / 30%); border-color: red; }',
      '.b { border-radius: 3px; border-top-left-radius: 1px; font-size: 0.9em; font: 12px/1 codicon; }',
      '.c { z-index: 5; margin: 0 6px; gap: 0.5em; top: calc(var(--x) + 3px); }',
    ].join('\n');
    assert.deepEqual(
      violations(css).map((v) => `${v.line} ${v.rule}`),
      [
        '1 hex color',
        '1 color function',
        '1 named color',
        '2 raw radius',
        '2 raw radius',
        '2 raw font size',
        '2 raw font size',
        '3 raw z-index',
        '3 raw spacing',
        '3 raw spacing',
        '3 raw spacing',
      ],
    );
  });

  it('accepts tokens, VS Code variables and keywords', () => {
    const css = [
      '/* #000 red 3px */',
      '.a { color: var(--vscode-charts-red); border: 1px solid currentColor; background: transparent; }',
      '.b { border-radius: var(--radius-md); font: normal normal normal var(--icon-size-sm) / 1 codicon; }',
      ".c { font-size: inherit; z-index: var(--z-card); content: '#fff'; --x: 3px; }",
      '.d { color: color-mix(in srgb, var(--chip-color) 45%, transparent); }',
      '.e { margin: 0 var(--space-4); padding: 1px 0; left: calc(var(--depth, 0) * var(--tree-indent) + 1px); }',
    ].join('\n');
    assert.deepEqual(violations(css), []);
  });

  it('keeps raw values in tokens.css', () => {
    const files = readdirSync(WEBVIEW).filter((f) => f.endsWith('.css') && f !== TOKENS);
    assert.ok(files.includes('main.css') && files.includes('components.css'), files.join(', '));
    const unexpected = files.flatMap((file) =>
      violations(readFileSync(join(WEBVIEW, file), 'utf8'))
        .filter((v) => !ALLOWED.some((a) => a.file === file && a.declaration === v.declaration))
        .map((v) => `${file}:${v.line} ${v.rule}: ${v.declaration}`),
    );
    assert.deepEqual(unexpected, [], 'use a token from tokens.css, or add an ALLOWED entry with its reason');
  });

  it('allows only exceptions that still exist', () => {
    for (const a of ALLOWED) {
      const found = violations(readFileSync(join(WEBVIEW, a.file), 'utf8')).some(
        (v) => v.declaration === a.declaration,
      );
      assert.ok(found, `stale ALLOWED entry: ${a.file} ${a.declaration}`);
    }
  });
});
