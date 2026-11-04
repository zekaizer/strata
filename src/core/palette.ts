import { contrast, oklch, toHex, type Rgb } from './color.ts';

export interface PaletteInput {
  /** Editor background. */
  background: Rgb;
  /** Backgrounds a line may be drawn over besides the editor background (selection, hover). */
  surfaces: Rgb[];
  /** Minimum contrast of every lane color against every surface. */
  minContrast: number;
}

/**
 * Hue order: blue, red, green, purple, amber, teal, pink, lime. Consecutive
 * entries (including last to first) are at least 120° apart, because lanes are
 * colored in this rotation and neighbours must stay distinguishable.
 */
export const LANE_HUES: readonly number[] = [250, 25, 145, 310, 75, 195, 345, 115];

const CHROMA = 0.15;

/**
 * Lane colors as hex, one per entry of LANE_HUES. Lightness starts from a
 * fixed value per background polarity and moves away from the background until
 * every color meets `minContrast` against every surface, so custom themes get
 * a palette as readable as the built-in ones.
 */
export function lanePalette({ background, surfaces, minContrast }: PaletteInput): string[] {
  const all = [background, ...surfaces];
  const darkBackground = contrast([1, 1, 1], background) > contrast([0, 0, 0], background);
  const step = darkBackground ? 0.01 : -0.01;
  return LANE_HUES.map((h) => {
    let l = darkBackground ? 0.72 : 0.56;
    let color = oklch(l, CHROMA, h);
    while (Math.min(...all.map((s) => contrast(color, s))) < minContrast && l > 0.05 && l < 0.99) {
      l += step;
      color = oklch(l, CHROMA, h);
    }
    return toHex(color);
  });
}
