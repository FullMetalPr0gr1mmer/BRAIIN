// Colour maths for the theme (Admin v2 E4, AV-27): hex parsing, WCAG 2.2 contrast, alpha
// compositing and HSL. Pure and dependency-free, so the editor (browser), the Worker (save
// and publish) and the tests share one copy. The contrast maths are the CI audit's
// (scripts/contrast-audit.mjs) and src/lib/admin/contrast.ts's: tests/lib/themeGate.spec.ts
// holds them equal on sample pairs, and the database's copy (app.theme_contrast, the E4
// migration) is the same formula.

/** `#RRGGBB` (any case) as three 0-255 channels, or null. Only six digits: what tokens store. */
export function channels(hex: string): [number, number, number] | null {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return null;
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Three channels (rounded, clamped to 0-255) as lower-case `#rrggbb`. */
export function toHex([r, g, b]: readonly [number, number, number]): string {
  const part = (c: number) =>
    Math.min(255, Math.max(0, Math.round(c)))
      .toString(16)
      .padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

function linear(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** Relative luminance (WCAG 2.2) of a `#rrggbb` colour. Throws on anything else. */
export function luminance(hex: string): number {
  const rgb = channels(hex);
  if (!rgb) throw new Error(`not a colour: ${hex}`);
  return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
}

/** The contrast ratio of two colours, 1 to 21, whichever is lighter. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * `top` painted at `alpha` over `under`: what a translucent colour shows over an opaque ground
 * (the audit's precomposited values, CSS `color-mix(in srgb, top p%, under)`). The alpha is in
 * hundredths and each channel is computed in whole numbers, rounded half up, so the database's
 * copy (app.theme_mix) gives the same colour to the last digit: floating point would put
 * 255 × 0.7 at 178.49999… here and 178.5 there.
 */
export function mix(top: string, alpha: number, under: string): string {
  const a = channels(top);
  const b = channels(under);
  if (!a || !b) throw new Error(`not a colour: ${a ? under : top}`);
  const k = Math.round(alpha * 100);
  if (k < 0 || k > 100) throw new Error(`alpha out of range: ${alpha}`);
  const channel = (i: 0 | 1 | 2) => Math.floor((a[i] * k + b[i] * (100 - k) + 50) / 100);
  return toHex([channel(0), channel(1), channel(2)]);
}

/** `#rrggbb` as [hue 0-360, saturation 0-100, lightness 0-100] (the prototype's opsHexHsl). */
export function toHsl(hex: string): [number, number, number] {
  const rgb = channels(hex);
  if (!rgb) throw new Error(`not a colour: ${hex}`);
  const [r, g, b] = rgb.map((x) => x / 255) as [number, number, number];
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return [h, s * 100, l * 100];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** [hue, saturation, lightness] as `#rrggbb` (the prototype's opsHslHex). */
export function fromHsl(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp(s, 0, 100) / 100;
  const lig = clamp(l, 0, 100) / 100;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return toHex([f(0) * 255, f(8) * 255, f(4) * 255]);
}

/** `#RRGGBB` upper case (how settings store a colour), or null for anything that is not one. */
export function normalizeColour(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  const hex = raw.startsWith('#') ? raw.slice(1) : raw;
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toUpperCase()}` : null;
}
