// Keeps the webview's stylesheets on the design system (docs/design-system.md): raw colors, radii,
// font sizes, spacing and z-indexes belong in src/webview/tokens.css only, and tokens.css holds only
// tokens that earn their place.
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

/** Token families kept whole even where a member has a single use, each with its reason. */
const FAMILIES: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /^--space-\d+$/, reason: 'the spacing scale' },
  { pattern: /^--radius-(sm|md|lg)$/, reason: 'the radius scale' },
  { pattern: /^--font-size(-sm|-xs)?$/, reason: 'the type scale' },
  { pattern: /^--line-height(-prose)?$/, reason: 'the line height scale' },
  { pattern: /^--icon-size(-sm)?$/, reason: 'the icon size scale' },
  { pattern: /^--z-[a-z]+$/, reason: 'the stacking layers, ordered against each other' },
  { pattern: /^--badge-[a-z]+$/, reason: 'ref kind colors: a chip selects its color by kind' },
];

/** Tokens outside a family that may have a single use, each with the design decision it holds. */
const SINGLE_USE: readonly { token: string; reason: string }[] = [
  {
    token: '--surface-sunken-hover',
    reason: 'theme-specific: list hover mixed with black in light themes, plain list hover in dark and high contrast',
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

/** How many times each custom property `tokens` defines is read with `var()` in `sources`, tokens.css included. */
function tokenUses(tokens: string, sources: readonly string[]): Map<string, number> {
  const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
  const uses = new Map<string, number>();
  for (const m of strip(tokens).matchAll(/(--[\w-]+)\s*:/g)) uses.set(m[1]!, 0);
  for (const source of [tokens, ...sources])
    for (const m of strip(source).matchAll(/var\(\s*(--[\w-]+)/g))
      if (uses.has(m[1]!)) uses.set(m[1]!, uses.get(m[1]!)! + 1);
  return uses;
}

/** Tokens read fewer than twice that no family or SINGLE_USE entry keeps. */
function unearned(uses: Map<string, number>): string[] {
  return [...uses]
    .filter(
      ([name, n]) => n < 2 && !FAMILIES.some((f) => f.pattern.test(name)) && !SINGLE_USE.some((s) => s.token === name),
    )
    .map(([name, n]) => `${name} (${n} use${n === 1 ? '' : 's'})`);
}

const webviewSources = () =>
  readdirSync(WEBVIEW)
    .filter((f) => (f.endsWith('.css') || f.endsWith('.ts')) && f !== TOKENS)
    .map((f) => readFileSync(join(WEBVIEW, f), 'utf8'));

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
      '.f { outline: 1px dashed var(--vscode-toolbar-hoverOutline, var(--vscode-contrastActiveBorder, transparent)); }',
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

describe('token set', () => {
  it('flags a token read fewer than twice outside a family', () => {
    const tokens = [
      ':root {',
      '  --color-link: var(--vscode-textLink-foreground);',
      '  --shadow-color: var(--vscode-widget-shadow);',
      '  --shadow: 0 2px 8px var(--shadow-color);',
      '  --color-fg: var(--vscode-foreground);',
      '  --color-unused: red;',
      '  --space-24: 24px;',
      '  --badge-stash: var(--vscode-descriptionForeground);',
      '  --surface-sunken-hover: var(--vscode-list-hoverBackground);',
      '}',
      '/* var(--color-unused) var(--color-unused) */',
    ].join('\n');
    const css = [
      '.a { color: var(--color-link); box-shadow: var(--shadow); }',
      '.b { color: var(--color-fg); }',
      '.c { box-shadow: var(--shadow); padding: var(--space-24); }',
    ].join('\n');
    const ts = "el.style.color = 'var(--color-fg)';";
    assert.deepEqual(unearned(tokenUses(tokens, [css, ts])), [
      '--color-link (1 use)',
      '--shadow-color (1 use)',
      '--color-unused (0 uses)',
    ]);
  });

  it('keeps only tokens used twice, in a family or with a reason', () => {
    const uses = tokenUses(readFileSync(join(WEBVIEW, TOKENS), 'utf8'), webviewSources());
    assert.ok(uses.size > 0);
    assert.deepEqual(
      unearned(uses),
      [],
      'inline a single-use alias at its use (var(--vscode-…, fallback)), or add it to FAMILIES or SINGLE_USE with its reason',
    );
  });

  it('keeps only single-use entries that still apply', () => {
    const uses = tokenUses(readFileSync(join(WEBVIEW, TOKENS), 'utf8'), webviewSources());
    for (const { token } of SINGLE_USE) {
      assert.ok(uses.has(token), `stale SINGLE_USE entry: ${token} is not defined`);
      assert.ok(uses.get(token)! < 2, `stale SINGLE_USE entry: ${token} is used ${uses.get(token)} times`);
      assert.ok(!FAMILIES.some((f) => f.pattern.test(token)), `stale SINGLE_USE entry: ${token} is in a family`);
    }
  });
});
