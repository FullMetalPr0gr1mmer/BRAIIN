// WCAG 2.2 AA contrast gate (CLAUDE.md DoD #4 — "neon-on-dark passes AA"). Pure Node, no
// browser: computes the contrast ratio for every foreground/background PAIR actually used
// in the public UI and fails CI if any is below its AA threshold. This complements the
// axe DOM checks (which run in the staged perf-seo-a11y workflow) with a fast, always-on
// token-level guard so a palette tweak can't silently regress contrast.
//
// Thresholds (WCAG 2.2): 4.5:1 normal text, 3.0:1 large text (≥18.66px bold / ≥24px) and
// non-text UI (borders/focus indicators, 1.4.11).

// Palette — keep in sync with public/styles/global.css :root tokens (brand system:
// Klein blue on black & paper white, from the approved "Brain Station UI" design).
const T = {
  bg: '#000000', // --bs-bg / --bs-black
  surface: '#0a0f24', // --bs-surface
  midnight: '#000d30', // --bs-midnight (consent banner, select popovers)
  fg: '#ffffff', // --bs-fg
  muted: '#a6adbf', // --bs-muted (secondary text on dark)
  accent: '#22a9ff', // --bs-accent / --bs-sky (links, stat values on dark)
  skySoft: '#9ed4ff', // --bs-sky-soft (svc-row numbers on the Klein hover fill)
  klein: '#0024bc', // --bs-klein (.cta / .badge / .svc-row hover fill)
  cobalt: '#024cff', // --bs-cobalt (focus outline, hero accent word — display size)
  paper: '#ffffff', // --bs-paper (light sections)
  ink: '#000000', // --bs-ink (text on paper)
  dim: '#4a5468', // --bs-dim (secondary text on paper)
  ok: '#2ecc71',
  err: '#ff5a5a',
};

// (foreground, background, minRatio, where) — every real on-screen pairing.
const PAIRS = [
  // dark sections (hero, slogan, clients, contact) + interior pages
  ['fg', 'bg', 4.5, 'body text on black'],
  ['fg', 'surface', 4.5, 'card/section text'],
  ['fg', 'midnight', 4.5, 'consent banner / select options'],
  ['muted', 'bg', 4.5, 'secondary text on page'],
  ['muted', 'surface', 4.5, 'secondary text on cards'],
  ['accent', 'bg', 4.5, 'links / sky accents on black'],
  ['accent', 'surface', 4.5, 'links / stat value on cards'],
  ['fg', 'klein', 4.5, '.cta + .badge label (white on Klein)'],
  ['skySoft', 'klein', 4.5, 'svc-row number on Klein hover fill'],
  ['cobalt', 'bg', 3.0, 'hero accent word (display-size text)'],
  ['cobalt', 'bg', 3.0, 'focus outline (UI, 1.4.11)'],
  ['ok', 'surface', 3.0, 'form success border (UI)'],
  ['err', 'surface', 3.0, 'form error border (UI)'],
  // paper sections (about intro, services, social, footer)
  ['ink', 'paper', 4.5, 'body text on paper'],
  ['dim', 'paper', 4.5, 'secondary text on paper (svc numbers/blurbs)'],
  ['klein', 'paper', 4.5, 'tags / accents on paper'],
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
