import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { contrast, oklabDistance, parseCssColor, type Rgb } from '../../src/core/color.ts';
import { LANE_HUES, lanePalette } from '../../src/core/palette.ts';

const rgb = (s: string, under?: Rgb): Rgb => {
  const c = parseCssColor(s, under);
  assert.ok(c, s);
  return c;
};

/** Built-in themes captured from VS Code (npm run capture-themes). */
const captured = ['dark', 'light', 'high-contrast', 'high-contrast-light'].map((name) => {
  const vars = JSON.parse(
    readFileSync(new URL(`../../playground/themes/${name}.json`, import.meta.url), 'utf8'),
  ) as Record<string, string>;
  const bg = rgb(vars['--vscode-editor-background']!);
  const surfaces = ['--vscode-list-activeSelectionBackground', '--vscode-list-hoverBackground']
    .map((k) => vars[k] && parseCssColor(vars[k], bg))
    .filter((c): c is Rgb => c !== undefined);
  return { name, bg, surfaces, min: name.startsWith('high-contrast') ? 4.5 : 3 };
});

/** Popular third-party editor backgrounds, including mid-tone ones. */
const thirdParty = [
  '#002b36',
  '#fdf6e3',
  '#272822',
  '#0d1117',
  '#282a36',
  '#2e3440',
  '#1e1e2e',
  '#eff1f5',
  '#3f3f3f',
  '#f5f5dc',
].map((h) => ({ name: h, bg: rgb(h), surfaces: [] as Rgb[], min: 3 }));

describe('lanePalette', () => {
  it('has well-separated hues', () => {
    assert.ok(LANE_HUES.length >= 8);
    LANE_HUES.forEach((h, i) => {
      const next = LANE_HUES[(i + 1) % LANE_HUES.length]!;
      const d = Math.min(Math.abs(h - next), 360 - Math.abs(h - next));
      assert.ok(d >= 60, `hues ${h} and ${next} are adjacent lanes but only ${d}° apart`);
    });
  });

  for (const t of [...captured, ...thirdParty]) {
    it(`meets ${t.min}:1 contrast on every surface (${t.name})`, () => {
      const colors = lanePalette({ background: t.bg, surfaces: t.surfaces, minContrast: t.min });
      assert.equal(colors.length, LANE_HUES.length);
      for (const c of colors) {
        for (const s of [t.bg, ...t.surfaces]) {
          const r = contrast(rgb(c), s);
          assert.ok(r >= t.min, `${c} on ${t.name}: ${r.toFixed(2)}`);
        }
      }
      colors.forEach((c, i) => {
        const next = colors[(i + 1) % colors.length]!;
        const d = oklabDistance(rgb(c), rgb(next));
        assert.ok(d >= 0.1, `neighbouring lanes ${c} and ${next} differ by only ΔEok ${d.toFixed(3)}`);
      });
    });
  }
});
