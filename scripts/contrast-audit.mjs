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
  // UI v2 (2026-09)
  mist: '#f3f5fa', // --bs-mist (soft paper: "why us" / "who we are")
  ink2: '#2a2f3a', // --bs-ink-2 (secondary copy on mist / paper)
  ink3: '#3a404c', // --bs-ink-3 (case-study body copy on paper)
  errSoft: '#ff8a8a', // --bs-err-soft (error text on dark)
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
  ['cobalt', 'paper', 3.0, 'focus outline on paper — footer links (UI, 1.4.11)'],
  // UI v2 (2026-09): mist blocks, secondary/case-study copy, error text on dark
  ['ink', 'mist', 4.5, 'body text on mist'],
  ['ink2', 'mist', 4.5, 'secondary copy on mist'],
  ['ink2', 'paper', 4.5, 'secondary copy on paper'],
  ['ink3', 'paper', 4.5, 'case-study body copy on paper'],
  ['dim', 'mist', 4.5, 'tags / meta on mist'],
  ['klein', 'mist', 4.5, 'accents on mist'],
  ['errSoft', 'bg', 4.5, 'form error text on black'],
  ['errSoft', 'surface', 4.5, 'form error text on cards'],
];

// ---- Admin palette — keep in sync with public/styles/admin.css :root tokens ----
//
// The CMS needs its own suite: /admin is exempt from Core Web Vitals but NOT from DoD
// #4, and the light editorial palette is a port of a reference design that fails AA in
// two places on its own site. Asserting the pairs here is what stops those two values
// coming back the next time someone "restores" a colour to match the source.
const A_LIGHT = {
  bg: '#ffffff', // --ad-bg (card ground, inputs)
  surface: '#faf8f4', // --ad-surface (sidebar, table head)
  surface2: '#f2efe9', // --ad-surface-2 (content ground, default button, badge)
  fg: '#111111', // --ad-fg
  muted: '#666666', // --ad-muted — #888888 in the source is 3.54:1 and fails
  accentText: '#7f6026', // --ad-accent-text (accent TEXT only)
  accent: '#8a6a2a', // --ad-accent (fills/rules; the source's #b8955a fails 1.4.11)
  primary: '#111111', // --ad-primary (filled button ground)
  primaryFg: '#ffffff', // --ad-primary-fg
  focus: '#111111', // --ad-focus
  ok: '#2d6a4f',
  warn: '#8a5a00',
  danger: '#a63232',
  info: '#1e4d8c',
};

// The dormant dark theme under :root[data-theme='dark']. Asserted even though no toggle
// ships yet — an unasserted palette is where the next regression hides, and the tokens
// whose job is contrast (primary, focus) are re-decided per theme rather than mirrored,
// which is exactly the kind of decision worth pinning down in CI.
const A_DARK = {
  bg: '#0b0b0f',
  surface: '#14141b',
  surface2: '#1c1c26',
  fg: '#e8e8ea',
  muted: '#a0a0ab',
  accentText: '#00e5ff',
  accent: '#00e5ff',
  primary: '#00e5ff',
  primaryFg: '#04141a',
  focus: '#00e5ff',
  ok: '#4ade80',
  warn: '#ffb84d',
  danger: '#ff6b6b',
  info: '#7fb0f0',
};

// Same pair list for both themes — the point of a token layer is that the component
// pairings do not change when the palette does.
const ADMIN_PAIRS = [
  ['fg', 'bg', 4.5, 'body text on a card'],
  ['fg', 'surface', 4.5, 'sidebar nav label'],
  ['fg', 'surface2', 4.5, 'text on the content ground'],
  ['muted', 'bg', 4.5, 'help text / .stat-label on a card'],
  ['muted', 'surface', 4.5, 'table th, sidebar group title'],
  ['muted', 'surface2', 4.5, '.badge[data-status=draft]'],
  ['accentText', 'bg', 4.5, 'accent text on a card'],
  ['accentText', 'surface', 4.5, 'accent text on the sidebar'],
  ['accentText', 'surface2', 4.5, 'accent text on a default button'],
  ['primaryFg', 'primary', 4.5, '[data-variant=primary] label'],
  ['ok', 'bg', 4.5, ".msg[data-kind='ok']"],
  ['ok', 'surface2', 4.5, '.badge[data-status=published]'],
  ['warn', 'surface2', 4.5, '.badge[data-status=scheduled]'],
  ['danger', 'bg', 4.5, ".msg[data-kind='error']"],
  ['danger', 'surface2', 4.5, '.badge[data-status=archived]'],
  ['info', 'bg', 4.5, 'informational text'],
  // Non-text (1.4.11): focus ring, and the gold in its only legitimate role.
  ['focus', 'bg', 3.0, 'focus outline on a card (UI)'],
  ['focus', 'surface2', 3.0, 'focus outline on the content ground (UI)'],
  ['accent', 'bg', 3.0, 'gold bar fill on a card (UI)'],
  ['accent', 'surface2', 3.0, 'gold bar fill on the content ground (UI)'],
];

// --ad-disabled is deliberately absent: WCAG 1.4.3 exempts inactive controls, and
// asserting a threshold the spec does not require would be false rigour.

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

function suite(title, tokens, pairs, source) {
  console.log(`WCAG 2.2 AA contrast gate — ${title}\n`);
  console.log('  ratio   min   fg/bg                         where');
  let bad = 0;
  for (const [fg, bg, min, where] of pairs) {
    const r = ratio(tokens[fg], tokens[bg]);
    const pass = r >= min;
    if (!pass) bad++;
    const mark = pass ? '✓' : '✗';
    console.log(
      `  ${mark} ${r.toFixed(2).padStart(5)}  ${String(min).padStart(3)}   ${`${fg} on ${bg}`.padEnd(28)}  ${where}`,
    );
  }
  if (bad) console.log(`\n  ${bad} pair(s) below AA — adjust tokens in ${source}.`);
  console.log('');
  failed += bad;
}

suite('public palette', T, PAIRS, 'public/styles/global.css');
suite('admin palette (light)', A_LIGHT, ADMIN_PAIRS, 'public/styles/admin.css :root');
suite(
  'admin palette (dark, dormant)',
  A_DARK,
  ADMIN_PAIRS,
  "public/styles/admin.css :root[data-theme='dark']",
);

if (failed) {
  console.log(`Contrast gate: FAIL (${failed} pair(s) below AA).`);
  process.exit(1);
}
console.log('Contrast gate: PASS (all UI pairs meet WCAG 2.2 AA).');
