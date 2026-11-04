import { describe, expect, test } from 'vitest';
import { codeAnchored } from '@schemas/sectionAppearance';
import {
  DEFAULT_ABOUT_SECTIONS,
  DEFAULT_CATALOG_SECTIONS,
  DEFAULT_CONTACT_SECTIONS,
  DEFAULT_HOME_SECTIONS,
  DEFAULT_WORK_SECTIONS,
  ensureContactInquiry,
  homeHeroCtaHref,
  withHeroPreset,
  withHomeData,
  withHomeIntro,
  type SectionData,
} from '@/lib/sections/types';
import { withLeaders } from '@/lib/sections/about';
import { withContactData } from '@/lib/sections/contact';
import { composeJoinPage } from '@/lib/sections/join';
import { customSections } from '@/lib/sections/customPage';
import { composeServicesPage } from '@/lib/services/servicesPage';
import { CARDS, DISCIPLINES, FAQ, LEADERS, POSTER } from './fixtures';
import { LOCALES, renderSections } from './harness';

// Section appearance on the page (Admin v2 E9), through SectionRenderer as a page renders it:
//   - nothing chosen changes nothing, on every route page and on a custom page, both languages
//     (the render snapshots, tests/render/sections.spec.ts, are unchanged too);
//   - each choice is an attribute on the section's own first element, with no wrapper and no
//     `style=`, and the rules hold on the real components;
//   - the kinds the code map calls code-anchored are exactly the ones whose first element names
//     an id (CODE_ANCHORED_TYPES against the markup);
//   - the preview's marker and the attributes sit together.

const t = (en: string, ar: string) => ({ en, ar });
const featured = CARDS.filter((c) => c.isFeatured);

/** The route pages' default compositions, as their routes compose them (sections.spec.ts). */
const PAGES: Record<string, (locale: 'en' | 'ar') => SectionData[]> = {
  home: () =>
    withHomeData(withHomeIntro(DEFAULT_HOME_SECTIONS), {
      featured,
      ctaHref: homeHeroCtaHref(DEFAULT_HOME_SECTIONS, featured.length),
      disciplines: DISCIPLINES,
    }),
  about: () => withLeaders(DEFAULT_ABOUT_SECTIONS, LEADERS),
  contact: (locale) =>
    withContactData(ensureContactInquiry(withHeroPreset(DEFAULT_CONTACT_SECTIONS, 'contact')), {
      groups: DISCIPLINES,
      faq: FAQ[locale],
    }),
  services: () => composeServicesPage([], DISCIPLINES),
  join: () => composeJoinPage([], null),
  work: () =>
    DEFAULT_WORK_SECTIONS.map((s) =>
      s.type === 'workHero'
        ? { ...s, data: { cards: CARDS } }
        : s.type === 'projectGrid'
          ? { ...s, data: { cards: CARDS, selection: {} } }
          : s,
    ),
  catalog: () =>
    DEFAULT_CATALOG_SECTIONS.map((s) =>
      s.type === 'pageHead'
        ? { ...s, data: { count: CARDS.length } }
        : s.type === 'projectCatalog'
          ? { ...s, data: { cards: CARDS, selection: {} } }
          : s,
    ),
};

const TEXT_BLOCK: SectionData = {
  type: 'textBlock',
  props: {
    tag: t('A tag', 'وسم'),
    heading: t('A text block', 'نص'),
    body: {
      en: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }],
      },
      ar: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'مرحبا' }] }],
      },
    },
  },
};
const GALLERY: SectionData = {
  type: 'gallery',
  props: { heading: t('A gallery', 'معرض'), items: [{ kind: 'image', mediaId: POSTER.id }] },
};
const VIDEO: SectionData = {
  type: 'video',
  props: { heading: t('A video', 'فيديو'), mediaId: POSTER.id },
};

/** A custom page's composition (E11): its banner hero, a text block, a call to action. */
const custom = (extra: Partial<SectionData> = {}): SectionData[] =>
  customSections(
    [{ type: 'hero' }, { ...TEXT_BLOCK, ...extra }, { type: 'cta' }],
    t('How we work', 'كيف نشتغل'),
  );

/** The first element's opening tag of the section `cls` names. */
const openingOf = (html: string, cls: string): string => {
  const m = new RegExp(`<section[^>]*class="${cls}"[^>]*>`).exec(html);
  expect(m, cls).not.toBeNull();
  return m![0];
};

describe('nothing chosen, nothing changes', () => {
  for (const [name, compose] of Object.entries(PAGES)) {
    for (const locale of LOCALES) {
      test(`${name} (${locale}): an empty appearance renders the page byte for byte`, async () => {
        const sections = compose(locale);
        const before = await renderSections(sections, locale);
        const after = await renderSections(
          sections.map((s) => ({ ...s, appearance: {} })),
          locale,
        );
        expect(after).toBe(before);
        expect(before).not.toMatch(/data-(bg|space|reveal)=/);
      });
    }
  }
  for (const locale of LOCALES) {
    test(`a custom page (${locale}) renders byte for byte with nothing chosen`, async () => {
      const before = await renderSections(custom(), locale);
      expect(await renderSections(custom({ appearance: {} }), locale)).toBe(before);
      expect(before).not.toMatch(/data-(bg|space|reveal)=/);
    });
  }
});

describe('each choice on the real components', () => {
  for (const locale of LOCALES) {
    test(`a text block, third on a page (${locale}): id, background, spacing, reveal`, async () => {
      const html = await renderSections(
        [
          { type: 'slogan' },
          { type: 'cta' },
          {
            ...TEXT_BLOCK,
            appearance: {
              anchor: 'our-story',
              background: 'ink',
              spacing: 'roomy',
              reveal: 'rise',
            },
          },
        ],
        locale,
      );
      expect(openingOf(html, 'blk-text')).toBe(
        '<section id="our-story" data-bg="ink" data-space="roomy" data-reveal="rise" class="blk-text">',
      );
      expect(html).not.toContain('style=');
    });

    test(`a gallery and a video (${locale})`, async () => {
      const html = await renderSections(
        [
          { type: 'slogan' },
          { type: 'cta' },
          { ...GALLERY, appearance: { background: 'klein', spacing: 'compact', reveal: 'fade' } },
          { ...VIDEO, appearance: { spacing: 'roomy', anchor: 'the-film' } },
        ],
        locale,
      );
      expect(openingOf(html, 'blk-gal')).toBe(
        '<section data-bg="klein" data-space="compact" data-reveal="fade" class="blk-gal">',
      );
      expect(openingOf(html, 'blk-video')).toBe(
        '<section id="the-film" data-space="roomy" class="blk-video">',
      );
    });

    test(`a custom page (${locale}): its text block opens the page, so its reveal is dropped`, async () => {
      const html = await renderSections(
        custom({ appearance: { reveal: 'fade', background: 'mist', anchor: 'how' } }),
        locale,
      );
      expect(openingOf(html, 'blk-text')).toBe(
        '<section id="how" data-bg="mist" class="blk-text">',
      );
    });
  }

  test('a call to action takes a reveal and an anchor, never a background or spacing', async () => {
    const html = await renderSections(
      [
        { type: 'slogan' },
        { type: 'slogan' },
        {
          type: 'cta',
          appearance: { background: 'ink', spacing: 'roomy', reveal: 'fade', anchor: 'next' },
        },
      ],
      'en',
    );
    expect(html).toMatch(/<section id="next" data-reveal="fade" class="lead-band klein-band"/);
    expect(html).not.toMatch(/data-(bg|space)=/);
  });

  test('a code-anchored section keeps its own id, whatever its row says', async () => {
    const sections = PAGES['contact']!('en').map((s) =>
      s.type === 'contactInquiry' ? { ...s, appearance: { anchor: 'ask' } } : s,
    );
    const html = await renderSections(sections, 'en');
    expect(openingOf(html, 'contact-inquiry')).toContain('id="inquiry"');
    expect(html).not.toContain('id="ask"');
  });

  test('an anchor a discipline’s panel holds on the Services page is dropped', async () => {
    const sections = [
      ...composeServicesPage([], DISCIPLINES),
      { ...TEXT_BLOCK, appearance: { anchor: DISCIPLINES[0]!.slug } },
    ];
    const html = await renderSections(sections, 'en');
    expect(html.match(new RegExp(`id="${DISCIPLINES[0]!.slug}"`, 'g'))).toHaveLength(1);
  });

  test('the preview’s marker and the attributes sit together', async () => {
    const html = await renderSections(
      [
        { type: 'slogan' },
        { type: 'cta' },
        {
          ...TEXT_BLOCK,
          id: '33333333-3333-4333-8333-000000000001',
          appearance: { background: 'ink' },
        },
      ],
      'en',
      undefined,
      { preview: {} } as Partial<App.Locals>,
    );
    expect(openingOf(html, 'blk-text')).toBe(
      '<section data-pv-section="33333333-3333-4333-8333-000000000001" data-bg="ink" class="blk-text">',
    );
  });
});

describe('the code-anchored kinds are the ones whose first element names an id', () => {
  test('every section of every route page, both languages', async () => {
    const seen: string[] = [];
    for (const compose of Object.values(PAGES)) {
      for (const locale of LOCALES) {
        for (const s of compose(locale)) {
          const html = await renderSections([s], locale);
          const m = /<(?!(?:script|style|link|template|meta)\b)([a-zA-Z][\w-]*)\b[^>]*>/.exec(html);
          if (!m) continue; // a section that renders nothing (no data)
          if (s.type === 'hero') continue; // the home hero opens with its intro plate
          const hasId = /\sid="/.test(m[0]);
          expect(hasId, `${s.type} ${String(s.props?.['variant'] ?? '')}`).toBe(
            codeAnchored(s.type, s.props?.['variant']),
          );
          seen.push(s.type);
        }
      }
    }
    // Every code-anchored kind was seen at least once (the list is not wider than the markup).
    for (const type of [
      'aboutIntro',
      'aboutWho',
      'clientsMarquee',
      'contact',
      'contactInquiry',
      'faq',
      'hello',
      'joinApply',
      'leadership',
      'projectCatalog',
      'projectGrid',
      'selectedWork',
      'servicesOverview',
      'testimonials',
    ]) {
      expect(seen, type).toContain(type);
    }
  }, 120_000);
});
