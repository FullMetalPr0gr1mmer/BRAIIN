import { describe, expect, test } from 'vitest';
import { RENDERED_SECTION_TYPES, type RenderedSectionType } from '@/lib/sections/registry';
import { SECTION_COPY } from '@/lib/sections/copy';
import { withHeroPreset, type HeroPreset, type SectionData } from '@/lib/sections/types';
import { CARDS, DISCIPLINES, IDENTITY, LEADERS, STATS, TESTIMONIALS } from './fixtures';
import { LOCALES, renderSections } from './harness';

// Per section type and per look: the built-in copy (src/lib/sections/copy/) IS what the
// section renders with no content (Admin v2 F6, ui.md AV-23 "rendering with empty content
// equals the copy module"). Two renders through SectionRenderer, one with `content: {}`
// and one with the look's built-in content stored as the content, must be the same bytes,
// so a page editor that prefills its fields with this copy and stores only what differs
// changes nothing on the page by opening it. Then each copy field, set to other words,
// must change the output: the field is the one the section reads in that place, so the
// equality above is not a section ignoring its content.
//
// The fields a type declares `notVerbatim` are the exception, and the spec holds the
// declaration to the truth: stored as written, each of them DOES change the output.

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
  faq: { default: {} },
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
};

const compose = (type: string, place: Place, content: object): SectionData[] => {
  const section: SectionData = {
    type,
    props: { ...place.props, ...content },
    ...(place.data ? { data: place.data } : {}),
  };
  return place.preset ? withHeroPreset([section], place.preset) : [section];
};

const without = (content: object, fields: readonly string[]) =>
  Object.fromEntries(Object.entries(content).filter(([k]) => !fields.includes(k)));

/** The field's value with every `{ en, ar }` pair of strings replaced by other words. */
function otherWords(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(otherWords);
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.en === 'string' && typeof o.ar === 'string') {
      return { en: 'Qzx other words', ar: 'كلمات أخرى قزكس' };
    }
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, otherWords(v)]));
  }
  return value;
}

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
    const { content: looks, notVerbatim } = SECTION_COPY[type];
    for (const [look, builtIn] of Object.entries(looks)) {
      const place = PLACES[type][look];
      if (!place) continue; // the test above fails instead
      for (const locale of LOCALES) {
        test(`${type} ${look} (${locale})`, async () => {
          const empty = await renderSections(compose(type, place, {}), locale);
          // Something rendered, so the comparisons below compare a section.
          expect(empty.length, 'the section rendered nothing').toBeGreaterThan(100);

          const stored = await renderSections(
            compose(type, place, without(builtIn, notVerbatim)),
            locale,
          );
          expect(stored).toBe(empty);

          for (const [field, value] of Object.entries(builtIn)) {
            const changed = otherWords(value);
            const isText = JSON.stringify(changed) !== JSON.stringify(value);
            if (!isText && !notVerbatim.includes(field)) continue;
            const html = await renderSections(
              compose(
                type,
                place,
                notVerbatim.includes(field) ? { [field]: value } : { [field]: changed },
              ),
              locale,
            );
            expect(
              html,
              notVerbatim.includes(field)
                ? `${type}.${field} renders the same when stored: drop it from notVerbatim`
                : `${type}.${field} is not read in this place`,
            ).not.toBe(empty);
          }
        });
      }
    }
  }
});

describe('the brand is filled as written', () => {
  // `%brand%` in a section's copy, built-in or authored, is the public identity's brand,
  // copied as written: never read as a `$&`-style replacement pattern.
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
    ['joinApply', { lead: authored }],
  ];

  for (const [type, content] of CASES) {
    for (const locale of LOCALES) {
      test(`${type} ${JSON.stringify(content)} (${locale})`, async () => {
        const html = await renderSections(compose(type, {}, content), locale, identity);
        expect(html).toContain(escaped);
        expect(html).not.toContain('%brand%');
      });
    }
  }
});
