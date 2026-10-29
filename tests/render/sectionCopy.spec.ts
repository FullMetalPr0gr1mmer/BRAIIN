import { describe, expect, test } from 'vitest';
import type { Locale } from '@schemas/primitives';
import { RENDERED_SECTION_TYPES, type RenderedSectionType } from '@/lib/sections/registry';
import { SECTION_COPY, type SectionCopy } from '@/lib/sections/copy';
import { withHeroPreset, type HeroPreset, type SectionData } from '@/lib/sections/types';
import { CARDS, DISCIPLINES, FAQ, IDENTITY, LEADERS, STATS, TESTIMONIALS } from './fixtures';
import { LOCALES, renderSections } from './harness';

// Per section type and per look: the built-in copy (src/lib/sections/copy/) IS what the
// section renders with no content (Admin v2 F6, ui.md AV-23 "rendering with empty content
// equals the copy module"), and the page editor can store only what differs from it.
//
// Two renders through SectionRenderer, one with `content: {}` and one with the look's
// built-in content stored as the content, must be the same bytes. So must each unit the
// editor stores on its own: a field, or a group the type declares `together` (an accent
// with its heading), stored alone at its built-in value. Then each field, varied (other
// words, or an accent one word over) and stored with the rest of its unit, must change
// the output: the field is the one the section reads in that place, so the equalities
// above are not a section ignoring its content, and a field the type reads only beside
// another is caught unless the two are declared together. Every built-in field must be one
// the spec can vary.
//
// The fields a type declares `notVerbatim` are the exception, and the spec holds the
// declaration to the truth: stored as written, each of them DOES change the output. A
// `together` group is held to the truth too: each one is needed somewhere.

/** Where a look renders: its content's place keys, its route data, its page's preset. */
interface Place {
  props?: Record<string, unknown>;
  data?: Record<string, unknown>;
  preset?: HeroPreset;
}

const featured = CARDS.filter((c) => c.isFeatured);
const catalogue = { cards: CARDS, selection: {} };

/** One entry per look of every type: a new look must say where it renders. */
const PLACES: Record<RenderedSectionType, Record<string, Place>> = {
  hero: {
    default: {},
    contact: { preset: 'contact' },
    services: { preset: 'services' },
    join: { preset: 'join' },
  },
  servicesOverview: {
    home: { data: { mode: 'home', disciplines: DISCIPLINES } },
    page: { data: { mode: 'page', disciplines: DISCIPLINES } },
  },
  cta: { default: {} },
  social: { paper: { props: { variant: 'paper' } }, klein: { props: { variant: 'klein' } } },
  aboutStory: { default: {} },
  statistics: {
    cards: { data: { items: STATS } },
    band: { props: { variant: 'band', placement: 'home' }, data: { items: STATS } },
    reach: { props: { variant: 'reach', placement: 'about' }, data: { items: STATS } },
    proof: { props: { variant: 'proof', placement: 'work' }, data: { items: STATS } },
    services: { props: { variant: 'services', placement: 'services' }, data: { items: STATS } },
  },
  team: { default: {} },
  certifications: { default: {} },
  clientsMarquee: { default: {} },
  aboutIntro: { default: {} },
  slogan: { default: {} },
  contact: { default: { data: { groups: DISCIPLINES } } },
  contactInquiry: { default: { data: { groups: DISCIPLINES } } },
  contactChannels: { default: {} },
  // The questions are route data (Admin v2 U7): with none, the band renders nothing.
  faq: { default: { data: { items: FAQ.en } } },
  selectedWork: { default: { data: { cards: featured } } },
  testimonials: { default: { data: { items: TESTIMONIALS } } },
  aboutWho: { default: {} },
  leadership: { default: { data: { leaders: LEADERS } } },
  workHero: { default: { data: { cards: CARDS } } },
  proof: { default: {} },
  workIntro: { default: {} },
  projectGrid: { default: { data: catalogue } },
  pageHead: { default: { data: { count: CARDS.length } } },
  projectCatalog: { default: { data: catalogue } },
  hello: { default: { data: { groups: DISCIPLINES } } },
  serviceExplorer: { default: { data: { disciplines: DISCIPLINES } } },
  joinWhy: { default: {} },
  joinSteps: { default: {} },
  joinApply: { default: {} },
  // Admin v2 E10: no built-in copy, so the one look is empty (and renders nothing).
  textBlock: { default: {} },
  gallery: { default: {} },
  video: { default: {} },
};

type Content = Readonly<Record<string, unknown>>;

const compose = (type: string, place: Place, content: object): SectionData[] => {
  const section: SectionData = {
    type,
    props: { ...place.props, ...content },
    ...(place.data ? { data: place.data } : {}),
  };
  return place.preset ? withHeroPreset([section], place.preset) : [section];
};

const pick = (content: Content, fields: readonly string[]): Content =>
  Object.fromEntries(Object.entries(content).filter(([k]) => fields.includes(k)));

/**
 * What the page editor stores as one, among a look's fields: each `together` group (its
 * fields this look has), then every other field on its own. `notVerbatim` fields are never
 * stored as written, so they are in no unit.
 */
function units(builtIn: Content, copy: SectionCopy): string[][] {
  const fields = Object.keys(builtIn).filter((k) => !copy.notVerbatim.includes(k));
  const groups = copy.together
    .map((g) => g.filter((f) => fields.includes(f)))
    .filter((g) => g.length > 0);
  const grouped = new Set(groups.flat());
  return [...groups, ...fields.filter((f) => !grouped.has(f)).map((f) => [f])];
}

/** One word over: earlier where it can be, so the range still starts inside the line. */
const nudge = (n: number) => (n > 0 ? n - 1 : n + 1);

/**
 * The field's value, varied: every `{ en, ar }` pair of strings replaced by other words,
 * every accent range and word index moved by one word.
 */
function varied(value: unknown): unknown {
  if (typeof value === 'number') return nudge(value);
  if (Array.isArray(value)) return value.map(varied);
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.en === 'string' && typeof o.ar === 'string') {
      return { en: 'Qzx other words', ar: 'كلمات أخرى قزكس' };
    }
    if (typeof o.from === 'number') {
      const from = nudge(o.from);
      const to = typeof o.to === 'number' && o.to <= from ? { to: from + 1 } : {};
      return { ...o, from, ...to };
    }
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, varied(v)]));
  }
  return value;
}

/** A per-language field (`accentFromEn`, `accentFromAr`) is read on its language's page only. */
const readIn = (field: string, locale: Locale) =>
  /En$/.test(field) ? locale === 'en' : /Ar$/.test(field) ? locale === 'ar' : true;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

describe('every look has a place to render', () => {
  test('PLACES names exactly the looks of every type', () => {
    for (const type of RENDERED_SECTION_TYPES) {
      expect(Object.keys(PLACES[type]).sort(), type).toEqual(
        Object.keys(SECTION_COPY[type].content).sort(),
      );
    }
  });
});

describe('rendering with no content equals rendering the built-in copy', () => {
  for (const type of RENDERED_SECTION_TYPES) {
    const copy = SECTION_COPY[type];
    const { notVerbatim } = copy;
    for (const [look, content] of Object.entries(copy.content)) {
      const builtIn = content as Content;
      const place = PLACES[type][look];
      if (!place) continue; // the test above fails instead
      for (const locale of LOCALES) {
        test(`${type} ${look} (${locale})`, async () => {
          const render = (stored: object) => renderSections(compose(type, place, stored), locale);
          const empty = await render({});
          // Something rendered, so the comparisons below compare a section.
          expect(empty.length, 'the section rendered nothing').toBeGreaterThan(100);

          const whole = Object.fromEntries(
            Object.entries(builtIn).filter(([k]) => !notVerbatim.includes(k)),
          );
          expect(await render(whole), 'the whole look, stored').toBe(empty);

          for (const unit of units(builtIn, copy)) {
            const stored = pick(builtIn, unit);
            expect(
              await render(stored),
              `${type}: ${unit.join(' + ')} stored alone at its built-in renders differently: ` +
                'store it with the fields it is read with (declare them `together`)',
            ).toBe(empty);

            for (const field of unit) {
              const value = builtIn[field];
              const changed = varied(value);
              expect(same(changed, value), `${type}.${field}: a value the spec cannot vary`).toBe(
                false,
              );
              if (!readIn(field, locale)) continue;
              expect(
                await render({ ...stored, [field]: changed }),
                `${type}.${field} is not read in this place, or only beside a field ` +
                  'it is not declared `together` with',
              ).not.toBe(empty);
            }
          }

          for (const field of notVerbatim) {
            if (!(field in builtIn)) continue;
            expect(
              await render({ [field]: builtIn[field] }),
              `${type}.${field} renders the same when stored: drop it from notVerbatim`,
            ).not.toBe(empty);
          }
        });
      }
    }
  }
});

describe('every `together` group is one the type needs', () => {
  // Somewhere (a look, a language), a field of the group stored on its own renders other
  // than the per-field model expects: at its built-in it changes the page, or varied it
  // changes nothing. Otherwise the group would only make the editor store more than it must.
  for (const type of RENDERED_SECTION_TYPES) {
    const copy = SECTION_COPY[type];
    for (const group of copy.together) {
      test(`${type}: ${group.join(' + ')}`, async () => {
        let needed = false;
        for (const [look, content] of Object.entries(copy.content)) {
          const builtIn = content as Content;
          const place = PLACES[type][look];
          if (!place) continue;
          const here = group.filter((f) => f in builtIn);
          if (here.length < 2) continue;
          for (const locale of LOCALES) {
            const render = (stored: object) => renderSections(compose(type, place, stored), locale);
            const empty = await render({});
            for (const field of here) {
              if (!readIn(field, locale)) continue;
              const alone = await render(pick(builtIn, [field]));
              const variedAlone = await render({ [field]: varied(builtIn[field]) });
              if (alone !== empty || variedAlone === empty) needed = true;
            }
          }
        }
        expect(needed, `${type}: ${group.join(' + ')} are read apart; drop the group`).toBe(true);
      });
    }
  }
});

describe('the brand is filled as written', () => {
  // `%brand%` in a section's copy, built-in or authored, is the public identity's brand,
  // copied as written: never read as a `$&`-style replacement pattern. So is the `{brand}`
  // of the application band's consent line (packages/consent/recruitment.ts).
  const brand = 'Studio $& $$ $` One';
  const identity = { ...IDENTITY, brandName: { en: brand, ar: brand } };
  const escaped = brand.replace(/&/g, '&amp;');
  const authored = { en: 'Made at %brand%', ar: 'صنع في %brand%' };

  const CASES: [type: RenderedSectionType, content: object][] = [
    ['aboutIntro', {}],
    ['aboutStory', {}],
    ['joinWhy', {}],
    ['joinWhy', { lead: authored }],
    ['joinSteps', { lead: authored }],
    ['joinApply', {}],
    ['joinApply', { lead: authored }],
  ];

  for (const [type, content] of CASES) {
    for (const locale of LOCALES) {
      test(`${type} ${JSON.stringify(content)} (${locale})`, async () => {
        const html = await renderSections(compose(type, {}, content), locale, identity);
        expect(html).toContain(escaped);
        expect(html).not.toContain('%brand%');
        expect(html).not.toContain('{brand}');
      });
    }
  }
});
