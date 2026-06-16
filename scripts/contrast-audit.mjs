// WCAG 2.2 AA contrast gate (CLAUDE.md DoD #4 — "neon-on-dark passes AA"). Pure Node, no
// browser: computes the contrast ratio for every foreground/background PAIR actually used
// in the public UI and fails CI if any is below its AA threshold. This complements the
// axe DOM checks (which run in the staged perf-seo-a11y workflow) with a fast, always-on
// token-level guard so a palette tweak can't silently regress contrast.
//
// Thresholds (WCAG 2.2): 4.5:1 normal text, 3.0:1 large text (≥18.66px bold / ≥24px) and
// non-text UI (borders/focus indicators, 1.4.11).

// Palette — keep in sync with public/styles/global.css :root tokens.
const T = {
  bg: '#0b0b0f',
  surface: '#14141b',
  fg: '#e8e8ea',
  muted: '#a0a0ab',
  accent: '#00e5ff',
  border: '#2a2a35',
  ok: '#2ecc71',
  err: '#ff6b6b',
};

// (foreground, background, minRatio, where) — every real on-screen pairing.
const PAIRS = [
  ['fg', 'bg', 4.5, 'body text'],
  ['fg', 'surface', 4.5, 'card/section text'],
  ['muted', 'bg', 4.5, 'secondary text on page'],
  ['muted', 'surface', 4.5, 'secondary text on cards'],
  ['accent', 'bg', 4.5, 'links on page'],
  ['accent', 'surface', 4.5, 'links / stat value / headings on cards'],
  ['bg', 'accent', 4.5, '.cta button label (dark text on neon)'],
  ['accent', 'bg', 3.0, 'focus outline (UI, 1.4.11)'],
  ['ok', 'surface', 3.0, 'form success border (UI)'],
  ['err', 'surface', 3.0, 'form error border (UI)'],
];

function channel(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255,
    g = (n >> 8) & 255,
    b = n & 255;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function ratio(a, b) {
  const la = luminance(a),
    lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

let failed = 0;
console.log('WCAG 2.2 AA contrast gate — public palette\n');
console.log('  ratio   min   fg/bg                         where');
for (const [fg, bg, min, where] of PAIRS) {
  const r = ratio(T[fg], T[bg]);
  const pass = r >= min;
  if (!pass) failed++;
  const mark = pass ? '✓' : '✗';
  console.log(
    `  ${mark} ${r.toFixed(2).padStart(5)}  ${String(min).padStart(3)}   ${`${fg} on ${bg}`.padEnd(28)}  ${where}`,
  );
}
console.log('');
if (failed) {
  console.log(`Contrast gate: FAIL (${failed} pair(s) below AA). Adjust tokens in global.css.`);
  process.exit(1);
}
console.log('Contrast gate: PASS (all UI pairs meet WCAG 2.2 AA).');
