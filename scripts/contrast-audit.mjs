import { readFileSync, readdirSync } from 'node:fs';

// WCAG 2.2 AA contrast gate (CLAUDE.md DoD #4 — "neon-on-dark passes AA"). Pure Node, no
// browser: computes the contrast ratio for every foreground/background PAIR actually used
// in the public UI and fails CI if any is below its AA threshold. This complements the
// axe DOM checks (perf-seo-a11y.yml, which CI calls on every PR and push) with a fast,
// always-on token-level guard so a palette tweak can't silently regress contrast.
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
  // Round 2 (S4) — the service page (services.css "S4: service page")
  washMid: '#0138de', // .svc-vcard:hover wash (Klein → Cobalt, 150deg) at its midpoint — the furthest the number ever sits (RTL, top-right)
  vcardHoverP: '#d6e2ff', // .svc-vcard:hover p — white .84 over the wash's Cobalt end
  plusDisc: '#ebedfa', // .svc-vcard__plus — rgba(0,36,188,.08) over the white card
  caseCtx: '#cccccc', // .svc-case__ctx p — white .80 over black
  resBg: '#000c40', // .svc-res__i — rgba(0,36,188,.34) over black, the gradient's lighter end
  resLabel: '#b8bbca', // .svc-res__l — white .72 over resBg
  casePill: '#666666', // .svc-case__see — its .6 black glass over a WHITE poster
  // Round 2 (S3) — the /services explorer (services.css): the media caption pill's .7 glass
  // over a WHITE poster, and the selected tab's number (white .75 over Klein)
  xpCap: '#4d4d4d',
  xpTabNum: '#bfc8ee',
  // Join (join.css) — the application band on black, its Klein glow, and the form's
  // translucent grounds precomposited over black
  applyGlow: '#000f4f', // .join-apply::before — rgba(0,36,188,.42) over black, the glow's peak
  fieldBg: '#0b0b0b', // .af-grid .field input — white .045 over black
  placeholder: '#858585', // its placeholder — white .5 over fieldBg (the mockup's .34 fails AA)
  afChip: '#d1d1d1', // .af-chip span — white .82 over black
  dropBg: '#080808', // .af-drop — white .03 over black
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
  // Round 2 (S4): the service page — what it is (paper), the value band (mist + white cards),
  // the case block (black), more in {discipline} (paper), the floating button (Klein)
  ['dim', 'paper', 4.5, 'service body + "What you get" rows on paper'],
  ['klein', 'paper', 4.5, 'service kickers, "What you get" label, card numbers, current row'],
  ['fg', 'klein', 3.0, '"What you get" check (white on its Klein disc, UI)'],
  ['dim', 'mist', 4.5, 'value band lead line on mist'],
  ['klein', 'mist', 4.5, 'value band kicker + heading accent on mist'],
  ['dim', 'paper', 4.5, 'value card text on its white card'],
  ['klein', 'plusDisc', 3.0, 'value card plus (Klein on its tinted disc, UI)'],
  ['fg', 'cobalt', 4.5, 'value card title on the hover wash (worst: the Cobalt end)'],
  ['vcardHoverP', 'cobalt', 4.5, 'value card text on the hover wash (worst: the Cobalt end)'],
  ['skySoft', 'washMid', 4.5, 'value card number on the hover wash (at most its midpoint)'],
  ['skySoft', 'klein', 4.5, 'value card number on the hover wash (LTR: the Klein start)'],
  ['tagDark', 'bg', 4.5, 'case block chips on black'],
  ['caseCtx', 'bg', 4.5, 'case block "Where they were" copy on black'],
  ['chipCount', 'bg', 4.5, 'case block column heads (white .6) on black'],
  ['noteDark', 'bg', 4.5, 'case block "what we did" cells (white .7) on black'],
  ['accent', 'bg', 4.5, 'case block kicker, labels and row numbers (sky on black)'],
  ['fg', 'casePill', 4.5, 'case "See the full project" pill over a white poster (worst case)'],
  ['fg', 'resBg', 4.5, 'case result value on its card'],
  ['resLabel', 'resBg', 4.5, 'case result label on its card'],
  ['fg', 'cobalt', 4.5, 'floating "Skip to inquiry", hovered (white on Cobalt)'],
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
  // Join: "Why" on paper, "How it works" on mist (white cards), the application on black
  ['klein', 'paper', 4.5, 'join why: kicker, heading accent, reason numbers'],
  ['dim', 'paper', 4.5, 'join why: lead and reasons; steps: card text'],
  ['klein', 'mist', 4.5, 'join steps: kicker + heading accent on mist'],
  ['dim', 'mist', 4.5, 'join steps: lead on mist'],
  ['klein', 'paper', 4.5, 'join steps: time label on its white card'],
  ['paper', 'klein', 4.5, 'join steps: the number badge; a checked craft chip'],
  ['accent', 'applyGlow', 4.5, 'join apply: kicker + heading accent under the Klein glow'],
  ['fg', 'applyGlow', 4.5, 'join apply: heading and the closed notice under the glow'],
  ['muted', 'applyGlow', 4.5, 'join apply: lead line under the glow'],
  ['accent', 'bg', 4.5, 'join form: group titles, the privacy link (sky on black)'],
  ['muted', 'bg', 4.5, 'join form: field labels, consent text, the note'],
  ['chipCount', 'bg', 4.5, 'join form: "optional" (white .6; the mockup’s .4 is 3.7:1)'],
  ['fg', 'fieldBg', 4.5, 'join form: a field value'],
  ['placeholder', 'fieldBg', 4.5, 'join form: a placeholder'],
  ['afChip', 'bg', 4.5, 'join form: a craft chip label'],
  ['cobalt', 'bg', 3.0, 'join form: a checked chip edge, the chip and dropzone focus ring (UI)'],
  ['fg', 'dropBg', 4.5, 'join CV dropzone: title, file name, Remove'],
  ['muted', 'dropBg', 4.5, 'join CV dropzone: the rules line, the size'],
  ['errSoft', 'dropBg', 4.5, 'join CV dropzone: a refused file'],
  ['errSoft', 'bg', 4.5, 'join form: field errors, a refused consent'],
];

// ---- Admin palette — READ from public/styles/admin.css :root (Admin v2 F1) ----
//
// The CMS needs its own suite: /admin is exempt from Core Web Vitals but NOT from DoD
// #4. The tokens are parsed out of the stylesheet's :root block rather than copied here,
// so the gate checks the colours that ship and cannot drift from them. A token may be a
// hex literal, a reference to another token, a theme reference with a fallback
// (`var(--bs-klein, #0024bc)`: the admin does not load the public theme yet, so the
// fallback is what renders), or `color-mix(in srgb, A p%, B)`.
const ADMIN_CSS = readFileSync(new URL('../public/styles/admin.css', import.meta.url), 'utf8');

// The screen stylesheets (public/styles/admin/*.css, Admin v2 W0) only USE these tokens:
// one that declared its own would ship a colour this gate never reads, so it is refused
// here (tests/lib/adminStyles.spec.ts also keeps colour literals out of them).
const SCREEN_SHEETS = new URL('../public/styles/admin/', import.meta.url);
for (const name of readdirSync(SCREEN_SHEETS).filter((f) => f.endsWith('.css'))) {
  const css = readFileSync(new URL(name, SCREEN_SHEETS), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const token = /--ad-[\w-]+(?=\s*:)/.exec(css);
  if (token) throw new Error(`admin/${name} declares ${token[0]}: tokens live in admin.css :root`);
}

function adminTokens(css = ADMIN_CSS) {
  const block = /:root\s*\{([\s\S]*?)\n\}/.exec(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  if (!block) throw new Error('admin.css: no :root token block');
  const raw = {};
  for (const m of block[1].matchAll(/--ad-([\w-]+)\s*:\s*([^;]+);/g)) raw[m[1]] = m[2].trim();
  const resolved = {};
  const resolve = (value, depth = 0) => {
    if (depth > 8) throw new Error(`admin.css: token cycle at ${value}`);
    let v = value.trim();
    if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(v))
      return `#${[...v.slice(1)].map((c) => c + c).join('')}`.toLowerCase();
    let m = /^var\(\s*--ad-([\w-]+)\s*\)$/.exec(v);
    if (m) return resolve(raw[m[1]] ?? '', depth + 1);
    m = /^var\(\s*--[\w-]+\s*,\s*(.+)\)$/.exec(v);
    if (m) return resolve(m[1], depth + 1);
    m = /^color-mix\(\s*in srgb\s*,\s*(.+?)\s+(\d+(?:\.\d+)?)%\s*,\s*(.+)\)$/.exec(v);
    if (m) {
      const a = resolve(m[1], depth + 1);
      const b = resolve(m[3], depth + 1);
      if (!a || !b) return null;
      const p = Number(m[2]) / 100;
      const ch = (hex, i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
      return `#${[0, 1, 2]
        .map((i) =>
          Math.round(ch(a, i) * p + ch(b, i) * (1 - p))
            .toString(16)
            .padStart(2, '0'),
        )
        .join('')}`;
    }
    return null; // rgba lines, shadows, sizes: not colours a pair can use
  };
  for (const [name, value] of Object.entries(raw)) {
    const hex = resolve(value);
    if (hex) resolved[name] = hex;
  }
  return resolved;
}

const A = adminTokens();

// Each pair names two tokens (without the --ad- prefix). Text pairs need 4.5:1, the
// rest (control edges, focus rings, chart strokes, status dots) 3:1 (WCAG 1.4.11).
const ADMIN_PAIRS = [
  // Text on the grounds
  ...['card', 'bg', 'surface-2', 'preview'].flatMap((g) => [
    ['ink', g, 4.5, `body text on ${g}`],
    ['dim', g, 4.5, `secondary text, .admin-sub on ${g}`],
    ['dim2', g, 4.5, `table heads, hints, placeholders on ${g}`],
  ]),
  // Brand
  ['on-primary', 'primary', 4.5, 'primary button label, the current sidebar item'],
  ['on-primary', 'primary-hover', 4.5, 'primary button label on hover'],
  ['primary', 'card', 4.5, 'links (a.data-link, search hits) on a card'],
  ['primary', 'surface-2', 4.5, 'a link in a hovered table row'],
  ['primary', 'primary-soft', 4.5, '.msg, soft button, klein badge, pressed toolbar button'],
  ['primary', 'primary-soft-2', 4.5, 'soft button on hover'],
  // Status badges and messages
  ['ok-text', 'ok-soft', 4.5, 'published / ok badge'],
  ['warn-text', 'warn-soft', 4.5, 'draft / warn badge'],
  ['err-text', 'err-soft', 4.5, 'err badge, .msg error, danger button on hover'],
  ['sky-text', 'sky-soft', 4.5, 'scheduled / sky badge'],
  ['dim', 'gray-soft', 4.5, 'archived / gray badge'],
  ['note-ok-text', 'ok-soft', 4.5, ".msg[data-kind='ok']"],
  ['note-warn-text', 'warn-soft', 4.5, '.pii labels'],
  ['ink', 'warn-soft', 4.5, '.pii values'],
  ['err-text', 'card', 4.5, 'danger button, .field-error'],
  // The midnight sidebar, toasts and dark badges
  ['side-text', 'midnight', 4.5, 'sidebar links'],
  ['side-label', 'midnight', 4.5, 'sidebar group titles'],
  ['on-dark', 'count', 4.5, 'a count beside a sidebar link'],
  ['on-dark', 'midnight', 4.5, 'brand, hovered link, toast, dark badge and button'],
  // Avatar grounds behind white initials
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => [
    'on-primary',
    `tone-${i}`,
    4.5,
    `white initials on tone ${i}`,
  ]),
  // Non-text (1.4.11)
  ...['card', 'bg', 'surface-2'].flatMap((g) => [
    ['control', g, 3.0, `input, select, textarea and switch-off edge on ${g}`],
    ['focus', g, 3.0, `focus ring on ${g}`],
  ]),
  ['primary', 'card', 3.0, 'switch on, checkbox and radio fill'],
  ['focus-dark', 'midnight', 3.0, 'focus ring in the sidebar'],
  ['warn-text', 'card', 3.0, '.pii border'],
  ...[1, 2, 3, 4, 5, 6, 7].flatMap((i) => [
    [`series-${i}`, 'card', 3.0, `chart series ${i} on a card`],
    [`series-${i}`, 'bg', 3.0, `chart series ${i} on the ground`],
  ]),
  ['ok', 'midnight', 3.0, 'ok dot on a toast'],
  ['warn', 'midnight', 3.0, 'warn dot on a toast'],
  ['err', 'midnight', 3.0, 'err dot on a toast'],
  ['focus-dark', 'midnight', 3.0, 'info dot on a toast'],
];

// No disabled-state pair: WCAG 1.4.3 exempts inactive controls, and asserting a threshold
// the spec does not require would be false rigour.

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
    if (!tokens[fg] || !tokens[bg]) {
      bad++;
      console.log(`  ✗ missing token: ${tokens[fg] ? bg : fg}  (${where})`);
      continue;
    }
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
suite('admin palette (Admin v2)', A, ADMIN_PAIRS, 'public/styles/admin.css :root');

if (failed) {
  console.log(`Contrast gate: FAIL (${failed} pair(s) below AA).`);
  process.exit(1);
}
console.log('Contrast gate: PASS (all UI pairs meet WCAG 2.2 AA).');
