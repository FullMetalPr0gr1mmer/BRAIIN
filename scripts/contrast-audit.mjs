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
  skySoft: '#9ed4ff', // --bs-sky-soft (a sky tint that passes on the Klein fill)
  klein: '#0024bc', // --bs-klein (.cta / .badge fills)
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
  // UI v2 PR6 shared blocks — translucent text precomposited over its only background
  tbd: '#6b7384', // .sb__n--text — a stat value that is not a number yet (the mockup's #C9CDD6 was 1.5:1)
  tagDark: '#ebebeb', // .ftag — white .92 over black
  noteDark: '#b3b3b3', // .ftag--note — white .70 over black
  kleinTag: '#ccd3f2', // .klein-band .tag — white .80 over Klein
  kleinLead: '#e0e4f7', // .lead-band__row p — white .88 over Klein
  kleinRole: '#bfc8ee', // .tm__r — white .75 over Klein
  kleinCount: '#b2bdeb', // .tm__count — white .70 over Klein
  // UI v2 PR7 (home)
  okPanel: '#000b24', // .form-status.is-ok — rgba(2,76,255,.14) over black (the sent panel)
  // UI v2 PR8 — About's Klein "Follow the studio" band (social-strip--klein)
  kleinBox: '#0f31c0', // .sbox ground — white .06 over Klein
  kleinUser: '#bcc5ed', // .sbox__user — white .72 over that card ground
  // UI v2 PR10 (banner.css caption; work.css) — Our Work / All projects
  capWorst: '#545454', // .work-cap glass (.45 black) over the banner scrim at the caption's top edge (~.4) over a WHITE frame
  capTag: '#cfcfcf', // .work-cap__tag — white .72 over capWorst
  capMeta: '#cccccc', // .work-cap__m — white .70 over capWorst (the mockup's .58 on .26 glass)
  chipCount: '#999999', // .fchip i — white .60 over black (the mockup's .45 was 4.4:1)
  chipLabel: '#d9d9d9', // .fchip — white .85 over black
  pillBg: '#051824', // .fpill — sky .14 over black
  pillKey: '#b4babd', // .fpill__k — white .70 over pillBg
  // UI v2 PR9 (contact)
  touchCard: '#f9f9f9', // .touch-card — rgba(0,0,0,.025) over white (the channel cards)
  // UI v2 PR11 (case-study.css) — the case study
  nxWorst: '#636363', // .cs-next — a WHITE poster at the hover opacity (.65) under the .4 scrim
  nxKicker: '#e8e8e8', // .cs-next__k — white .85 over nxWorst (the mockup's .75 on no scrim was ~2.4:1)
  kwChip: '#e6e6e6', // .cs-kw li — white .90 over black
  lbWorst: '#141414', // .lightbox — the .92 black dialog over a WHITE page
  lbCount: '#b9b9b9', // .lightbox__c — white .70 over lbWorst
  // Round 2 (S2) — the discipline cards (global.css) over their worst case, a WHITE poster
  discWorst: '#666666', // .disc-card__clip::after — the .6 black the words sit on, over white
  discCount: '#eaeaea', // .disc-card__cnt — white .86 over discWorst
  discLine: '#f0f0f0', // .disc-card__line — white .90 over discWorst
  discPill: '#6d6d6d', // .disc-card__n — its .4 glass under the top scrim (.29 at its foot), over white
  // Round 2 (S2) — "Say hello" (services.css) on black, and under its Klein glow
  helloGlow: '#00125e', // .hello::before — rgba(0,36,188,.5) over black, the glow's peak
  helloLead: '#9e9e9e', // .hello__p — white .62 over black
  helloLeadGlow: '#9ea5c2', // .hello__p — white .62 over helloGlow
  helloIcon: '#010f33', // .hello__pts b — rgba(2,76,255,.2) over black
  // Round 2 (S2) — the service page's skip pill (services.css .hero__skip): its .5 glass
  // over a WHITE frame under the hero's top scrim (≈ .18 where the pill sits)
  skipWorst: '#686868',
  skipKicker: '#ededed', // .hero__skip small — white .88 over skipWorst
  // Round 2 (S3) — the /services explorer (services.css): the media caption pill's .7 glass
  // over a WHITE poster, and the selected tab's number (white .75 over Klein)
  xpCap: '#4d4d4d',
  xpTabNum: '#bfc8ee',
};

// (foreground, background, minRatio, where) — every real on-screen pairing.
const PAIRS = [
  // UI v2 PR6 shared blocks
  ['tbd', 'paper', 4.5, 'stat band: a non-numeric value on white'],
  ['tagDark', 'bg', 4.5, 'facet tag on a dark card'],
  ['noteDark', 'bg', 4.5, '"Confidential client" note on a dark card'],
  ['kleinTag', 'klein', 4.5, 'kicker tag on a Klein band'],
  ['kleinLead', 'klein', 4.5, 'lead band copy'],
  ['kleinRole', 'klein', 4.5, 'testimonial role on the Klein band'],
  ['kleinCount', 'klein', 4.5, 'testimonial counter on the Klein band'],
  ['paper', 'klein', 4.5, 'lead band email / quote text / Klein band headings'],
  ['klein', 'paper', 4.5, 'light badge CTA label (Klein on white)'],
  // UI v2 PR8 About: the Klein social cards (the head copy is kleinTag / kleinLead above)
  ['paper', 'kleinBox', 4.5, 'social card network name on the Klein band'],
  ['kleinUser', 'kleinBox', 4.5, 'social card handle on the Klein band'],
  // UI v2 PR10 — Our Work / All projects
  ['fg', 'capWorst', 4.5, 'work caption title + description over the worst-case frame'],
  ['capTag', 'capWorst', 4.5, 'work caption tag ("Latest project")'],
  ['capMeta', 'capWorst', 4.5, 'work caption meta (client, year)'],
  ['chipCount', 'bg', 4.5, 'filter chip count'],
  ['chipLabel', 'bg', 4.5, 'filter chip label'],
  ['fg', 'pillBg', 4.5, 'active filter pill value'],
  ['pillKey', 'pillBg', 4.5, 'active filter pill facet name'],
  // UI v2 PR11 — the case study
  ['fg', 'nxWorst', 4.5, 'next-project title over the worst-case poster (hover)'],
  ['nxKicker', 'nxWorst', 4.5, 'next-project kicker ("Next project") over the worst-case poster'],
  ['kwChip', 'bg', 4.5, 'keyword chip on the black title band'],
  ['ink3', 'mist', 4.5, 'case-study overview copy on mist'],
  ['lbCount', 'lbWorst', 4.5, 'lightbox counter'],
  ['fg', 'lbWorst', 4.5, 'lightbox controls (white glyphs)'],
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
  // UI v2 PR7 (home): Selected work on mist, the lead form's states on black
  ['cobalt', 'mist', 3.0, 'focus outline on mist — Selected work links (UI, 1.4.11)'],
  ['fg', 'okPanel', 4.5, 'lead form "sent" confirmation text'],
  ['err', 'bg', 3.0, 'invalid field border on black (UI, 1.4.11)'],
  // UI v2 PR9 (contact). Verified on production: the FAQ kicker and heading accent were sky
  // on the PAPER FAQ band — sky on white is 2.56:1 and fails 1.4.3. The FAQ is the design's
  // black band now (sky 8.2:1); the one light band (channels) takes Klein. Sky-on-paper is
  // deliberately absent from this list: it is not a pairing the site may use.
  ['accent', 'bg', 4.5, 'contact FAQ + inquiry kicker and heading accent (sky on black)'],
  ['muted', 'bg', 4.5, 'contact FAQ answers / section lead on black'],
  ['klein', 'paper', 4.5, 'contact channels kicker + heading accent (Klein on white)'],
  ['klein', 'touchCard', 4.5, 'contact channel card label (Klein on the card tint)'],
  ['ink', 'touchCard', 4.5, 'contact channel card value'],
  ['dim', 'touchCard', 4.5, 'contact channel card note'],
  // Round 2 (S2): the discipline cards — home on paper, /services on mist
  ['dim', 'mist', 4.5, 'discipline band (page mode): sub-line + hint on mist'],
  ['klein', 'mist', 4.5, 'discipline band (page mode): kicker + heading accent on mist'],
  ['dim', 'paper', 4.5, 'discipline band (home): sub-line + hint on paper'],
  ['fg', 'discWorst', 4.5, 'discipline card name over a white poster (worst case)'],
  ['discCount', 'discWorst', 4.5, 'discipline card count ("8 services") over a white poster'],
  ['discLine', 'discWorst', 4.5, 'discipline card short line over a white poster'],
  ['fg', 'discPill', 4.5, 'discipline card number pill over a white poster'],
  ['klein', 'paper', 3.0, 'discipline card arrow (Klein on its white disc, UI)'],
  ['paper', 'klein', 3.0, 'discipline card arrow, hovered (white on Klein, UI)'],
  ['klein', 'paper', 3.0, 'discipline card focus ring, outer (Klein against the band, UI)'],
  ['accent', 'midnight', 4.5, 'grouped service select: discipline heading (sky optgroup)'],
  // Round 2 (S2): "Say hello" — black band, Klein glow at its top
  ['accent', 'bg', 4.5, 'hello kicker + heading accent on black'],
  ['accent', 'helloGlow', 4.5, 'hello kicker + heading accent under the Klein glow'],
  ['fg', 'helloGlow', 4.5, 'hello heading + points under the Klein glow'],
  ['helloLead', 'bg', 4.5, 'hello lead line on black'],
  ['helloLeadGlow', 'helloGlow', 4.5, 'hello lead line under the Klein glow'],
  ['accent', 'helloIcon', 3.0, 'hello point icon (sky plus on its disc, UI)'],
  // Round 2 (S2): the service page's skip pill over footage
  ['fg', 'skipWorst', 4.5, 'skip pill label over a white frame (worst case)'],
  ['skipKicker', 'skipWorst', 4.5, 'skip pill kicker ("Been here before?") over a white frame'],
  // Round 2 (S3): /services — the proof band and the explorer, both on white
  ['ink', 'paper', 4.5, 'services proof statement, rating value, stat numbers; explorer copy'],
  ['klein', 'paper', 4.5, 'services proof accent + stars; explorer key line, tab/row numbers'],
  ['dim', 'paper', 4.5, 'services proof rating label + stat labels; explorer blurb'],
  ['tbd', 'paper', 4.5, 'services proof: a non-numeric value'],
  ['paper', 'klein', 4.5, 'explorer: the selected tab, a hovered Inquire pill'],
  ['xpTabNum', 'klein', 4.5, "explorer: the selected tab's number"],
  ['klein', 'paper', 3.0, 'explorer: the row underline and hover borders (UI)'],
  ['fg', 'xpCap', 4.5, 'explorer media caption name over a white poster (worst case)'],
  ['skySoft', 'xpCap', 4.5, 'explorer media caption number over a white poster (worst case)'],
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
