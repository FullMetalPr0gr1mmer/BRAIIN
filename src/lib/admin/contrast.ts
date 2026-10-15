// WCAG contrast between two colours (Admin v2 F5a), for the colour field's line ("White
// text on it: 10.6:1, passes AA") and, later, the theme gate (E4) and the stage colours
// (C9a). The same maths as scripts/contrast-audit.mjs, the CI gate over the stylesheets'
// tokens: tests/lib/contrast.spec.ts runs both on sample pairs and holds them equal, so the
// editor can never pass a colour the gate would fail.

/** `#RGB` or `#RRGGBB` (any case) as three 0-255 channels, or null. */
function channels(hex: string): [number, number, number] | null {
  const raw = hex.trim();
  const six = /^#[0-9a-f]{6}$/i.test(raw)
    ? raw.slice(1)
    : /^#[0-9a-f]{3}$/i.test(raw)
      ? [...raw.slice(1)].map((c) => c + c).join('')
      : null;
  if (!six) return null;
  const n = parseInt(six, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function linear(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** Relative luminance (WCAG 2.2), or null for a value that is not a hex colour. */
function luminance(hex: string): number | null {
  const rgb = channels(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb;
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/**
 * The contrast ratio of two hex colours, 1 to 21, whichever is lighter. NaN when either is
 * not a `#RGB` / `#RRGGBB` colour, so a caller never prints a ratio for a typo.
 */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return Number.NaN;
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** "10.6:1": one decimal, the way the audit and the designs write a ratio. */
export function formatContrast(ratio: number): string {
  if (!Number.isFinite(ratio)) return '';
  // Floored, not rounded: 4.47 must never read as "4.5:1" beside a "fails AA".
  return `${(Math.floor(ratio * 10) / 10).toFixed(1)}:1`;
}

/** The AA verdict for normal text, in words. */
export function contrastVerdict(ratio: number): string {
  if (!Number.isFinite(ratio)) return '';
  if (ratio >= 4.5) return 'passes AA';
  if (ratio >= 3) return 'passes AA for large text only';
  return 'fails AA';
}
