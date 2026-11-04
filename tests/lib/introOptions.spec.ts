import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  APPEARANCE_COLUMNS,
  HEADER_COLUMNS,
  INTRO_BACKDROPS,
  INTRO_COLUMNS,
  INTRO_DEFAULTS,
  INTRO_FADE,
  INTRO_HOLD,
  INTRO_TAGLINE_MAX,
  SiteAppearanceWriteSchema,
  appearanceColumnDefaults,
  stepValues,
} from '@schemas/appearance';
import { introAttributes, introFromRow } from '@/lib/appearance/intro';
import { SITE_APPEARANCE_INTRO_COLUMNS } from '@/lib/data/appearance';
import { siteAppearanceSingleton } from '@/lib/admin/singletons/siteAppearance';
import { loadingUi } from '@/lib/admin/ui/loading';
import { editHref } from '@/lib/release/words';
import { DEFAULT_HOME_SECTIONS, withHomeIntro, type SectionData } from '@/lib/sections/types';
import {
  BUILTIN_HINTS,
  contentOf,
  homeHero,
  introShown,
  introTarget,
  previewLine,
  previewLook,
  switchHint,
  switchMovable,
  switchOn,
  switchedContent,
  type IntroTarget,
} from '@/components/admin/screens/loading/model';

// The loading screen's look (Admin v2 E7, site_appearance's intro_ columns): the closed sets
// equal the SQL CHECKs, the schema, the reader and the attributes, the CSS buckets the site and
// the admin's preview map, the singleton's columns, and the screen's model (which section the
// switch writes, and what).

const MIGRATION = (() => {
  const file = readdirSync('supabase/migrations').find((f) =>
    /^\d{4}_loading_screen\.sql$/.test(f),
  );
  expect(file, 'the loading screen migration').toBeTruthy();
  return readFileSync(`supabase/migrations/${file}`, 'utf8');
})();
const GLOBAL = readFileSync('public/styles/global.css', 'utf8');
const ADMIN = readFileSync('public/styles/admin/loading.css', 'utf8');
const secs = (ms: number) => `${ms / 1000}s`;

describe('the buckets are the SQL CHECKs', () => {
  it('the backdrop is the CHECK’s closed set, video first (the default)', () => {
    expect(MIGRATION).toContain(
      `check (intro_backdrop in (${INTRO_BACKDROPS.map((b) => `'${b}'`).join(', ')}))`,
    );
    expect(MIGRATION).toContain(
      `intro_backdrop text not null default '${INTRO_DEFAULTS.backdrop}'`,
    );
  });

  it('the hold and the fade are the CHECKs’ ranges and steps, and their defaults the tokens', () => {
    expect(MIGRATION).toContain(
      `intro_hold_ms between ${INTRO_HOLD.min} and ${INTRO_HOLD.max} and intro_hold_ms % ${INTRO_HOLD.step} = 0`,
    );
    expect(MIGRATION).toContain(
      `intro_fade_ms between ${INTRO_FADE.min} and ${INTRO_FADE.max} and intro_fade_ms % ${INTRO_FADE.step} = 0`,
    );
    expect(MIGRATION).toContain(`intro_hold_ms int not null default ${INTRO_DEFAULTS.holdMs}`);
    expect(MIGRATION).toContain(`intro_fade_ms int not null default ${INTRO_DEFAULTS.fadeMs}`);
    // The defaults are the intro as built (global.css, body:has(.intro)).
    expect(GLOBAL).toMatch(
      /body:has\(\.intro\) \{\s*--bs-intro-hold: 1s;[^}]*--bs-intro-fade: 0\.45s;/,
    );
    expect(INTRO_DEFAULTS.holdMs).toBe(1000);
    expect(INTRO_DEFAULTS.fadeMs).toBe(450);
    expect(INTRO_HOLD.max).toBe(1500); // the site rule: never longer than 1.5 s
  });

  it('the tagline is 0098’s plain bilingual shape at the schema’s maximum, or null', () => {
    expect(MIGRATION).toContain(
      `intro_tagline is null or app.faq_text_ok(intro_tagline, ${INTRO_TAGLINE_MAX})`,
    );
    expect(MIGRATION).toContain('intro_bar boolean not null default false');
  });

  it('the columns: the anon grant, the registry row and the loader’s select name the same five', () => {
    const columns = Object.values(INTRO_COLUMNS);
    expect(SITE_APPEARANCE_INTRO_COLUMNS.split(',')).toEqual(columns);
    expect(MIGRATION).toContain(`grant select (${columns.join(', ')})`);
    expect(MIGRATION).toContain(`'{${[...Object.values(HEADER_COLUMNS), ...columns].join(',')}}'`);
    expect(Object.values(APPEARANCE_COLUMNS)).toEqual([
      ...Object.values(HEADER_COLUMNS),
      ...columns,
    ]);
  });
});

describe('the schema', () => {
  const ok = (v: Record<string, unknown>) =>
    SiteAppearanceWriteSchema.safeParse({ ...v, version: 1 }).success;

  it('takes every step of the hold and the fade, and nothing else', () => {
    for (const v of stepValues(INTRO_HOLD)) expect(ok({ holdMs: v }), `hold ${v}`).toBe(true);
    for (const v of stepValues(INTRO_FADE)) expect(ok({ fadeMs: v }), `fade ${v}`).toBe(true);
    expect(stepValues(INTRO_HOLD)).toHaveLength(11);
    expect(stepValues(INTRO_FADE)).toHaveLength(7);
    for (const v of [400, 1600, 750, 1000.5, 2000])
      expect(ok({ holdMs: v }), `hold ${v}`).toBe(false);
    for (const v of [250, 650, 325, '450']) expect(ok({ fadeMs: v }), `fade ${v}`).toBe(false);
  });

  it('takes the three backdrops, a boolean bar, and a tagline in both languages or none', () => {
    for (const b of INTRO_BACKDROPS) expect(ok({ backdrop: b })).toBe(true);
    expect(ok({ backdrop: 'none' })).toBe(false);
    expect(ok({ bar: true })).toBe(true);
    expect(ok({ bar: 'yes' })).toBe(false);
    expect(ok({ tagline: null })).toBe(true);
    expect(ok({ tagline: { en: 'From the brain', ar: 'من الفكرة' } })).toBe(true);
    expect(ok({ tagline: { en: 'Only English' } })).toBe(false);
    expect(ok({ tagline: { en: 'a'.repeat(61), ar: 'ب' } })).toBe(false);
    expect(ok({ tagline: { en: 'two\nlines', ar: 'ب' } })).toBe(false);
  });

  it('trims the tagline (the CHECK refuses untrimmed words)', () => {
    const parsed = SiteAppearanceWriteSchema.parse({
      tagline: { en: '  Spaced  ', ar: ' ب ' },
      version: 0,
    });
    expect(parsed.tagline).toEqual({ en: 'Spaced', ar: 'ب' });
  });
});

describe('the reader and the plate’s attributes', () => {
  it('no row, or an unreadable option, is the intro as built', () => {
    expect(introFromRow(null)).toEqual(INTRO_DEFAULTS);
    expect(
      introFromRow({
        intro_backdrop: 'neon',
        intro_bar: 'yes',
        intro_tagline: { en: 'only' },
        intro_hold_ms: 1600,
        intro_fade_ms: 325,
      }),
    ).toEqual(INTRO_DEFAULTS);
  });

  it('a readable row is read option by option', () => {
    expect(
      introFromRow({
        intro_backdrop: 'light',
        intro_bar: true,
        intro_tagline: { en: 'Hi', ar: 'أهلا' },
        intro_hold_ms: 1500,
        intro_fade_ms: 9999,
      }),
    ).toEqual({
      backdrop: 'light',
      bar: true,
      tagline: { en: 'Hi', ar: 'أهلا' },
      holdMs: 1500,
      fadeMs: INTRO_DEFAULTS.fadeMs,
    });
  });

  it('one data-* attribute per timing or backdrop option off its default, none at the defaults', () => {
    expect(introAttributes({ ...INTRO_DEFAULTS })).toEqual({});
    // The bar and the tagline are elements, not attributes.
    expect(
      introAttributes({ ...INTRO_DEFAULTS, bar: true, tagline: { en: 'a', ar: 'ب' } }),
    ).toEqual({});
    expect(
      introAttributes({ ...INTRO_DEFAULTS, backdrop: 'black', holdMs: 500, fadeMs: 600 }),
    ).toEqual({ 'data-backdrop': 'black', 'data-hold': '500', 'data-fade': '600' });
  });
});

describe('the CSS buckets', () => {
  // The no-preference block that holds the site's timing buckets.
  const motionBlock = () => {
    const at = GLOBAL.indexOf(
      '@media (prefers-reduced-motion: no-preference) {\n  body:has(.intro[data-hold=',
    );
    expect(at, 'the timing buckets sit in a no-preference block').toBeGreaterThan(0);
    return GLOBAL.slice(at, GLOBAL.indexOf('\n}\n', at));
  };

  it('global.css maps every step but the default to the token, once, inside no-preference', () => {
    for (const [range, attr, token, fallback] of [
      [INTRO_HOLD, 'data-hold', '--bs-intro-hold', INTRO_DEFAULTS.holdMs],
      [INTRO_FADE, 'data-fade', '--bs-intro-fade', INTRO_DEFAULTS.fadeMs],
    ] as const) {
      for (const v of stepValues(range)) {
        const rule = `body:has(.intro[${attr}='${v}']) {\n    ${token}: ${secs(v)};\n  }`;
        const count = GLOBAL.split(`.intro[${attr}='${v}']`).length - 1;
        if (v === fallback) {
          expect(count, `${attr} ${v} is the default: no rule`).toBe(0);
        } else {
          expect(motionBlock(), `${attr} ${v}`).toContain(rule);
          expect(count, `${attr} ${v} once`).toBe(1);
        }
      }
    }
  });

  it('reduced motion still zeroes both tokens and hides the plate', () => {
    const reduce = GLOBAL.slice(GLOBAL.indexOf('/* ---- Motion safety net ---- */'));
    expect(reduce).toMatch(/\.intro \{\s*display: none;\s*\}/);
    expect(reduce).toMatch(
      /body:has\(\.intro\) \{\s*--bs-intro-hold: 0s;\s*--bs-intro-fade: 0s;\s*\}/,
    );
  });

  it('every backdrop but the video has its rule, and an opaque plate lifts the consent banner', () => {
    for (const b of INTRO_BACKDROPS.filter((x) => x !== INTRO_DEFAULTS.backdrop)) {
      expect(GLOBAL).toContain(`.intro[data-backdrop='${b}'] {`);
    }
    expect(GLOBAL).toMatch(
      /body:has\(\.intro\[data-backdrop\]\) \.consent-banner \{\s*z-index: 91;\s*\}/,
    );
    // Above the plate (z-index 90), below the header (100).
    expect(GLOBAL).toMatch(/\.intro \{\s*position: fixed;\s*inset: 0;\s*z-index: 90;/);
  });

  it('the logo keeps its entrance from opacity .01 (the home LCP element, CLAUDE.md §6)', () => {
    expect(GLOBAL).toMatch(/@keyframes intro-logo-in \{\s*from \{\s*opacity: 0\.01;/);
    // What hangs below it starts at 0, so it is never an LCP candidate, and leaves the logo
    // where it is (out of flow).
    expect(GLOBAL).toMatch(/@keyframes intro-extra-in \{\s*from \{\s*opacity: 0;/);
    expect(GLOBAL).toMatch(/\.intro__below \{\s*position: absolute;/);
  });

  it('the plate’s extras pause with it while the logo loads', () => {
    expect(GLOBAL).toMatch(
      /body\.intro-waiting \.intro__below,\s*body\.intro-waiting \.intro__bar i,/,
    );
  });

  it('the admin’s preview maps the same steps (its own tokens)', () => {
    for (const [range, attr, token] of [
      [INTRO_HOLD, 'data-hold', '--ld-hold'],
      [INTRO_FADE, 'data-fade', '--ld-fade'],
    ] as const) {
      for (const v of stepValues(range)) {
        const isDefault = v === INTRO_DEFAULTS.holdMs || v === INTRO_DEFAULTS.fadeMs;
        if (isDefault) continue;
        expect(ADMIN, `${attr} ${v}`).toContain(
          `.ld-pv__plate[${attr}='${v}'] {\n  ${token}: ${secs(v)};\n}`,
        );
      }
    }
    expect(ADMIN).toMatch(/\.ld-pv__plate \{\s*--ld-hold: 1s;\s*--ld-fade: 0\.45s;/);
  });
});

describe('the singleton', () => {
  it('writes only the keys a save names: the Loading screen never writes the header', () => {
    const intro = siteAppearanceSingleton.toRow({ backdrop: 'black', holdMs: 800, version: 1 });
    expect(intro).toEqual({ intro_backdrop: 'black', intro_hold_ms: 800 });
    const header = siteAppearanceSingleton.toRow({ logoSize: 'l', version: 1 });
    expect(header).toEqual({ header_logo_size: 'l' });
  });

  it('reads and defaults every column of the row', () => {
    for (const column of Object.values(APPEARANCE_COLUMNS)) {
      expect(siteAppearanceSingleton.columns.split(',')).toContain(column);
    }
    expect(siteAppearanceSingleton.defaults).toEqual(appearanceColumnDefaults());
    expect(siteAppearanceSingleton.defaults).toMatchObject({
      intro_backdrop: 'video',
      intro_bar: false,
      intro_tagline: null,
      intro_hold_ms: 1000,
      intro_fade_ms: 450,
    });
  });

  it('the Loading screen’s form names the five, by their columns', () => {
    expect(loadingUi.fields.map((f) => [f.name, f.column])).toEqual(Object.entries(INTRO_COLUMNS));
    const hold = loadingUi.fields.find((f) => f.name === 'holdMs');
    expect(hold?.range).toMatchObject({ min: 500, max: 1500, step: 100 });
    const fade = loadingUi.fields.find((f) => f.name === 'fadeMs');
    expect(fade?.range).toMatchObject({ min: 300, max: 600, step: 50 });
  });

  it('a pending change that names only the intro opens the Loading screen', () => {
    expect(editHref('site_appearance', 't', ['intro_backdrop', 'intro_hold_ms'])).toBe(
      '/admin/appearance/loading',
    );
    expect(editHref('site_appearance', 't', ['header_tint', 'intro_bar'])).toBe(
      '/admin/appearance/header',
    );
    expect(editHref('site_appearance', 't')).toBe('/admin/appearance/header');
  });
});

describe('the screen’s model', () => {
  const row = (id: string, sort: number, extra: Record<string, unknown> = {}) => ({
    id,
    type: 'hero',
    visible: true,
    sort_order: sort,
    version: 3,
    ...extra,
  });

  it('the switch writes the first VISIBLE hero, in the site’s order', () => {
    expect(
      homeHero([
        row('b', 20),
        row('a', 10, { visible: false }),
        { id: 'c', type: 'statistics', visible: true, sort_order: 5 },
        row('d', 15),
      ]),
    ).toEqual({ id: 'd', version: 3, pending: null });
    expect(homeHero([row('a', 10, { visible: false })])).toBeNull();
    expect(homeHero([])).toBeNull();
  });

  it('carries the section’s pending change (releases on)', () => {
    expect(homeHero([row('a', 10, { draft: { id: 'p1', version: 4, op: 'update' } })])).toEqual({
      id: 'a',
      version: 3,
      pending: { id: 'p1', version: 4 },
    });
  });

  it('off stores intro: false; on removes the key; every other key is kept', () => {
    const content = { headline: { en: 'Hi', ar: 'أهلا' }, intro: false };
    expect(introShown(content)).toBe(false);
    expect(switchedContent(content, true)).toEqual({ headline: { en: 'Hi', ar: 'أهلا' } });
    expect(introShown({})).toBe(true);
    expect(introShown({ intro: true })).toBe(true);
    expect(switchedContent({ headline: { en: 'Hi', ar: 'أهلا' } }, false)).toEqual({
      headline: { en: 'Hi', ar: 'أهلا' },
      intro: false,
    });
    // The input is never changed in place.
    expect(content).toEqual({ headline: { en: 'Hi', ar: 'أهلا' }, intro: false });
    expect(contentOf({ content: null })).toEqual({});
    expect(contentOf({ content: ['x'] })).toEqual({});
  });

  it('the preview reads the form as it is, each unreadable value at its default', () => {
    expect(previewLook({})).toEqual({ ...INTRO_DEFAULTS, tagline: '' });
    expect(
      previewLook({
        backdrop: 'black',
        bar: true,
        tagline: { en: ' Hello ', ar: 'مرحبا' },
        holdMs: 600,
        fadeMs: 351,
      }),
    ).toEqual({ backdrop: 'black', bar: true, tagline: 'Hello', holdMs: 600, fadeMs: 450 });
  });

  it('says the preview in words', () => {
    expect(previewLine({ ...INTRO_DEFAULTS, tagline: '' })).toBe(
      'The logo over the home page video. It holds 1000 ms, then fades in 450 ms.',
    );
    expect(
      previewLine({ backdrop: 'light', bar: true, tagline: 'Hello', holdMs: 500, fadeMs: 300 }),
    ).toBe(
      'The logo on a light ground, a progress bar and the tagline “Hello”. It holds 500 ms, then fades in 300 ms.',
    );
  });
});

describe('the switch follows the home route’s fallback (E7 review, E7-C2)', () => {
  type Row = Record<string, unknown>;
  const section = (id: string, type: string, sort: number, extra: Row = {}): Row => ({
    id,
    type,
    visible: true,
    sort_order: sort,
    version: 1,
    ...extra,
  });
  const published = { id: 'home', status: 'published' };

  /**
   * Whether `/` opens with the plate for this page and these sections, as the route decides it:
   * getPageComposition reads a PUBLISHED page's sections as a visitor (visible ones only, in
   * order), and src/pages/index.astro falls back to DEFAULT_HOME_SECTIONS when that gives
   * none; withHomeIntro gives the plate to the first hero unless its content says `intro: false`.
   */
  function routeShowsPlate(page: Row | null, rows: readonly Row[]): boolean {
    const shown: SectionData[] =
      page?.['status'] === 'published'
        ? [...rows]
            .filter((row) => row['visible'] !== false)
            .sort(
              (a, b) =>
                Number(a['sort_order']) - Number(b['sort_order']) ||
                String(a['id']).localeCompare(String(b['id'])),
            )
            .map((row) => ({ type: String(row['type']), props: contentOf(row) }))
        : [];
    const composed = shown.length ? shown : DEFAULT_HOME_SECTIONS;
    const hero = withHomeIntro(composed).find((s) => s.type === 'hero');
    return hero?.props?.['intro'] === true;
  }

  /** What the switch shows for a target: the model's, over the content of the hero it names. */
  function switchShows(target: IntroTarget, rows: readonly Row[]): boolean {
    const row = target.kind === 'hero' ? rows.find((r) => r['id'] === target.hero.id) : undefined;
    return switchOn(target, contentOf(row ?? {}));
  }

  const hero = section('h', 'hero', 10);
  const heroOff = section('h', 'hero', 10, { content: { intro: false } });
  const cases: [string, Row | null, Row[], IntroTarget['kind']][] = [
    ['no home page in Pages', null, [], 'builtin'],
    [
      'a draft home page, its hero switched off',
      { ...published, status: 'draft' },
      [heroOff],
      'builtin',
    ],
    ['a scheduled home page', { ...published, status: 'scheduled' }, [hero], 'builtin'],
    ['an archived home page', { ...published, status: 'archived' }, [heroOff], 'builtin'],
    ['a published home page with no section', published, [], 'builtin'],
    [
      'a published home page whose every section is hidden',
      published,
      [
        section('h', 'hero', 10, { visible: false, content: { intro: false } }),
        section('s', 'slogan', 20, { visible: false }),
      ],
      'builtin',
    ],
    [
      'a published home page with no hero showing',
      published,
      [section('s', 'slogan', 10), section('h', 'hero', 20, { visible: false })],
      'nohero',
    ],
    ['a published home page, its hero on', published, [hero, section('s', 'slogan', 20)], 'hero'],
    [
      'a published home page, its hero off',
      published,
      [heroOff, section('s', 'slogan', 20)],
      'hero',
    ],
    [
      'two heroes: the first visible one carries the plate',
      published,
      [
        section('b', 'hero', 30, { content: { intro: false } }),
        section('a', 'hero', 20),
        section('z', 'hero', 5, { visible: false, content: { intro: false } }),
      ],
      'hero',
    ],
    [
      'two heroes, the first visible one off',
      published,
      [section('b', 'hero', 30), section('a', 'hero', 20, { content: { intro: false } })],
      'hero',
    ],
  ];

  for (const [name, page, rows, kind] of cases) {
    it(`${name}: the switch shows what the route renders`, () => {
      const target = introTarget(page, rows);
      expect(target.kind).toBe(kind);
      expect(switchShows(target, rows)).toBe(routeShowsPlate(page, rows));
      // It can be moved only where it changes what visitors see: over the hero they get.
      expect(switchMovable(target)).toBe(kind === 'hero');
    });
  }

  it('says why the built-in home page is what visitors see, and the hero it writes otherwise', () => {
    expect(introTarget(null, [])).toEqual({ kind: 'builtin', why: 'nohome' });
    expect(introTarget({ status: 'draft' }, [hero])).toEqual({
      kind: 'builtin',
      why: 'unpublished',
    });
    expect(introTarget(published, [section('s', 'slogan', 1, { visible: false })])).toEqual({
      kind: 'builtin',
      why: 'empty',
    });
    expect(introTarget(published, [hero])).toEqual({
      kind: 'hero',
      hero: { id: 'h', version: 1, pending: null },
    });
    for (const why of ['nohome', 'unpublished', 'empty'] as const) {
      const words = switchHint({ kind: 'builtin', why });
      expect(words).toBe(BUILTIN_HINTS[why]);
      expect(words).toContain('built-in one, with its loading screen');
      expect(words).not.toMatch(/[\u2013\u2014]/);
    }
    expect(switchHint({ kind: 'nohero' })).toContain('no hero section');
    expect(switchHint(null)).toContain('Saved with the home page');
    expect(switchHint(introTarget(published, [hero]))).toBe(switchHint(null));
  });

  it('the island renders with these functions: it reads the page with its sections and asks introTarget', () => {
    // The cases above hold the model; this holds the island to it, so the switch cannot go back
    // to reading the sections alone (homeHero) and miss the route's fallback.
    const island = readFileSync('src/components/admin/screens/loading/LoadingScreen.tsx', 'utf8');
    // The page's status, through the pages kernel, beside the section list.
    expect(island).toMatch(
      /adminFetch<Row>\(`\/api\/admin\/pages\/\$\{encodeURIComponent\(homePageId\)\}`\)/,
    );
    expect(island).toContain('const target = introTarget(page, rows);');
    expect(island).toContain('target: introTarget(null, [])');
    // On, movable and the hint are the model's, never worked out in the island.
    expect(island).toMatch(
      /const on = state\.kind === 'read' \? switchOn\(state\.target, state\.content\) : false;/,
    );
    expect(island).toContain('const hint = switchHint(target);');
    expect(island).toMatch(/disabled=\{busy \|\| target === null \|\| !switchMovable\(target\)\}/);
    // The toggle writes only over a hero of the home page visitors see.
    expect(island).toContain("if (state.kind !== 'read' || state.target.kind !== 'hero') return;");
    expect(island).not.toMatch(/\bhomeHero\(/);
  });
});
