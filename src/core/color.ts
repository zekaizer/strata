/** Linear-light sRGB, components in [0, 1]. */
export type Rgb = readonly [number, number, number];

const decode = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const encode = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Parses #rgb, #rgba, #rrggbb, #rrggbbaa, rgb() and rgba(). Alpha is composited over `under`. */
export function parseCssColor(css: string, under: Rgb = [0, 0, 0]): Rgb | undefined {
  const s = css.trim().toLowerCase();
  let gamma: number[] | undefined;
  let alpha = 1;
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? Array.from(hex, (d) => d + d).join('') : hex;
    const bytes = full.match(/../g)!.map((b) => parseInt(b, 16) / 255);
    gamma = bytes.slice(0, 3);
    alpha = bytes[3] ?? 1;
  } else {
    const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
    if (!m) return undefined;
    gamma = [m[1], m[2], m[3]].map((v) => Number(v) / 255);
    alpha = m[4] === undefined ? 1 : Number(m[4]);
  }
  // Browsers composite in gamma-encoded sRGB.
  const below = under.map(encode);
  const mixed = gamma.map((v, i) => clamp01(v * alpha + below[i]! * (1 - alpha)));
  return [decode(mixed[0]!), decode(mixed[1]!), decode(mixed[2]!)];
}

export function toHex(c: Rgb): string {
  return (
    '#' +
    c
      .map((v) =>
        // The epsilon keeps exact halves (e.g. 127.5) from rounding down after the decode/encode round trip.
        Math.round(encode(clamp01(v)) * 255 + 1e-9)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

const luminance = (c: Rgb) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** WCAG 2.x contrast ratio. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function oklchToLinear(l: number, c: number, h: number): Rgb {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const EPS = 1e-6;
const inGamut = (c: Rgb) => c.every((v) => v >= -EPS && v <= 1 + EPS);

/** OKLCH to linear sRGB, reducing chroma until the color is inside the sRGB gamut. */
export function oklch(l: number, c: number, h: number): Rgb {
  let rgb = oklchToLinear(l, c, h);
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear(l, mid, h))) lo = mid;
      else hi = mid;
    }
    rgb = oklchToLinear(l, lo, h);
  }
  return [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])];
}

function toOklab(c: Rgb): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * c[0] + 0.5363325363 * c[1] + 0.0514459929 * c[2]);
  const m = Math.cbrt(0.2119034982 * c[0] + 0.6806995451 * c[1] + 0.1073969566 * c[2]);
  const s = Math.cbrt(0.0883024619 * c[0] + 0.2817188376 * c[1] + 0.6299787005 * c[2]);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Euclidean distance in OKLab (ΔEok); about 0.02 is a just-noticeable difference. */
export function oklabDistance(a: Rgb, b: Rgb): number {
  const [x, y] = [toOklab(a), toOklab(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}
