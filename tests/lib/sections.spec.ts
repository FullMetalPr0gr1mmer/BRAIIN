import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ABOUT_SECTIONS,
  DEFAULT_CONTACT_SECTIONS,
  DEFAULT_HOME_SECTIONS,
  homeHeroCtaHref,
  workIntroLinkHref,
  withHomeData,
  withHomeIntro,
  type SectionData,
} from '@/lib/sections/types';
import { SECTION_CONTENT_SCHEMAS, type SectionType } from '@schemas/sections';
import { HOME_CACHE_ENTITIES } from '@/lib/sections/home';
import { tierATags } from '@/lib/http/cacheTags';
import { pickSelectedWork } from '@/lib/portfolio/selectedWork';
import { loadBlocks } from '../../scripts/gen-seeds.mjs';

// `withHomeIntro` is what decides that the brand intro plate exists at all. The plate is
// a full-viewport, opaque, pointer-capturing overlay, so "who turns it on" is a real
// safety question, not a styling one — see the intro block in public/styles/global.css.

describe('withHomeIntro', () => {
  it('turns the intro on for the first hero', () => {
    const out = withHomeIntro([{ type: 'hero' }]);
    expect(out[0]!.props).toEqual({ intro: true });
  });

  it('never touches a hero that is not the first one', () => {
    const out = withHomeIntro([{ type: 'hero' }, { type: 'hero' }]);
    expect(out[0]!.props).toEqual({ intro: true });
    expect(out[1]!.props).toBeUndefined();
  });

  it('leaves every other section type alone', () => {
    const input: SectionData[] = [{ type: 'aboutIntro' }, { type: 'hero' }, { type: 'contact' }];
    const out = withHomeIntro(input);
    expect(out[0]!.props).toBeUndefined();
    expect(out[1]!.props).toEqual({ intro: true });
    expect(out[2]!.props).toBeUndefined();
  });

  // The off switch. Route-level default, CMS override — an author who turns the intro
  // off in the CMS must win, or the field is decorative.
  it('lets an explicit CMS value win in both directions', () => {
    expect(withHomeIntro([{ type: 'hero', props: { intro: false } }])[0]!.props).toEqual({
      intro: false,
    });
    expect(withHomeIntro([{ type: 'hero', props: { intro: true } }])[0]!.props).toEqual({
      intro: true,
    });
  });

  it('preserves the rest of a section content payload', () => {
    const out = withHomeIntro([
      { type: 'hero', visible: true, props: { headline: { en: 'A', ar: 'ب' } } },
    ]);
    expect(out[0]!.visible).toBe(true);
    expect(out[0]!.props).toEqual({ intro: true, headline: { en: 'A', ar: 'ب' } });
  });

  it('does not mutate its input — the defaults array is a module singleton', () => {
    const before = JSON.stringify(DEFAULT_HOME_SECTIONS);
    withHomeIntro(DEFAULT_HOME_SECTIONS);
    expect(JSON.stringify(DEFAULT_HOME_SECTIONS)).toBe(before);
    // Specifically: the shared default must not acquire the plate for other callers.
    expect(DEFAULT_HOME_SECTIONS[0]!.props).toBeUndefined();
  });

  it('is a no-op on a composition with no hero at all', () => {
    const out = withHomeIntro([{ type: 'contact' }]);
    expect(out).toEqual([{ type: 'contact' }]);
  });

  it('the home default composition still opens with a hero', () => {
    // If this ever stops being true the intro silently disappears from the home page.
    expect(DEFAULT_HOME_SECTIONS[0]!.type).toBe('hero');
  });
});

// ── Home (UI v2 PR7) ──────────────────────────────────────────────────────────────

describe('the home composition', () => {
  const ORDER = [
    'hero',
    'clientsMarquee',
    'selectedWork',
    'statistics',
    'testimonials',
    'servicesOverview',
    'aboutIntro',
    'slogan',
    'contact',
    'social',
  ];

  it('is the design order: hero, clients, work, numbers, quotes, services, why us, slogan, contact, social', () => {
    expect(DEFAULT_HOME_SECTIONS.map((s) => s.type)).toEqual(ORDER);
  });

  it('shows the numbers as the home band and the quotes as the Klein carousel', () => {
    const props = (type: string) => DEFAULT_HOME_SECTIONS.find((s) => s.type === type)?.props;
    expect(props('statistics')).toEqual({ variant: 'band', placement: 'home' });
    expect(props('testimonials')).toEqual({ variant: 'klein', placement: 'home' });
  });

  it('the seeded home composition is the default one (dev/CI/staging render what code would)', () => {
    type Row = { type: string; content: Record<string, unknown>; sort_order: number };
    const rows = (loadBlocks() as unknown as { table: string; rows: Row[] }[])
      .filter((b) => b.table === 'page_sections')
      .flatMap((b) => b.rows)
      .filter((r) => JSON.stringify(r).includes('"slug":"home"'))
      .sort((a, b) => a.sort_order - b.sort_order);
    expect(rows.map((r) => r.type)).toEqual(ORDER);
    for (const [i, row] of rows.entries()) {
      expect(row.content, row.type).toEqual(DEFAULT_HOME_SECTIONS[i]!.props ?? {});
    }
  });

  it('every DEFAULT_* composition carries content its schema accepts', () => {
    for (const s of [
      ...DEFAULT_HOME_SECTIONS,
      ...DEFAULT_ABOUT_SECTIONS,
      ...DEFAULT_CONTACT_SECTIONS,
    ]) {
      const schema = SECTION_CONTENT_SCHEMAS[s.type as SectionType];
      // The contact hero's `banner`/`ctaHref` are code-only route props, not CMS content.
      if (!schema || s.type === 'hero') continue;
      const parsed = schema.safeParse(s.props ?? {});
      expect(parsed.success, `${s.type}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  it('its cache tags cover every table the page reads, within the purge limit', () => {
    const tags = tierATags({ route: 'home', locale: 'en', entities: HOME_CACHE_ENTITIES });
    for (const t of [
      'page:home',
      'portfolio:all',
      'clients:all',
      'services:all',
      'disciplines:all',
      'statistics:all',
      'testimonials:all',
    ]) {
      expect(tags).toContain(t);
    }
    expect(tags.length).toBeLessThanOrEqual(30);
  });
});

describe('homeHeroCtaHref: the hero CTA never points at a band that is not there', () => {
  const withBand: SectionData[] = [{ type: 'hero' }, { type: 'selectedWork' }];

  it('goes to the Selected work band when it will render', () => {
    expect(homeHeroCtaHref(withBand, 3)).toBe('#selected-work');
  });

  it('goes to Our Work when nothing is featured (production starts with drafts)', () => {
    expect(homeHeroCtaHref(withBand, 0)).toBe('/portfolio');
  });

  it('goes to Our Work when an editor hid or removed the band', () => {
    expect(homeHeroCtaHref([{ type: 'hero' }, { type: 'selectedWork', visible: false }], 3)).toBe(
      '/portfolio',
    );
    expect(homeHeroCtaHref([{ type: 'hero' }], 3)).toBe('/portfolio');
  });
});

describe("workIntroLinkHref: Our Work's intro link never points at a grid that is not there", () => {
  const withGrid: SectionData[] = [{ type: 'workIntro' }, { type: 'projectGrid' }];

  it('goes to the featured grid when it will render', () => {
    expect(workIntroLinkHref(withGrid, 6, 12)).toBe('#projects');
  });

  it('goes to All projects when nothing is featured, or the grid is hidden or removed', () => {
    expect(workIntroLinkHref(withGrid, 0, 12)).toBe('/portfolio/all');
    expect(
      workIntroLinkHref([{ type: 'workIntro' }, { type: 'projectGrid', visible: false }], 6, 12),
    ).toBe('/portfolio/all');
    expect(workIntroLinkHref([{ type: 'workIntro' }], 6, 12)).toBe('/portfolio/all');
  });

  it('has no target at all while nothing is published (production starts with drafts)', () => {
    expect(workIntroLinkHref(withGrid, 0, 0)).toBeNull();
  });
});

describe('withHomeData: route data, never CMS content', () => {
  const cards = [{ slug: 'the-rider' }];
  const disciplines = [{ slug: 'branding' }];

  it('hands the featured cards to every Selected work band and the CTA to the first hero', () => {
    const out = withHomeData(
      [{ type: 'hero' }, { type: 'selectedWork' }, { type: 'hero' }, { type: 'social' }],
      { featured: cards, ctaHref: '/portfolio', disciplines },
    );
    expect(out[0]!.data).toEqual({ ctaHref: '/portfolio' });
    expect(out[1]!.data).toEqual({ cards });
    expect(out[2]!.data).toBeUndefined();
    expect(out[3]).toEqual({ type: 'social' });
  });

  it('keeps authored props apart from the injected data', () => {
    const out = withHomeData(
      [{ type: 'selectedWork', props: { featuredSlug: 'notebook', cards: ['forged'] } }],
      { featured: cards, ctaHref: '#selected-work', disciplines },
    );
    // The component reads its projects from `data`, which SectionRenderer passes AFTER the
    // content spread — a CMS key named `cards` can never replace them.
    expect(out[0]!.props).toEqual({ featuredSlug: 'notebook', cards: ['forged'] });
    expect(out[0]!.data).toEqual({ cards });
  });

  it('does not mutate the shared defaults', () => {
    const before = JSON.stringify(DEFAULT_HOME_SECTIONS);
    withHomeData(DEFAULT_HOME_SECTIONS, { featured: cards, ctaHref: '/portfolio', disciplines });
    expect(JSON.stringify(DEFAULT_HOME_SECTIONS)).toBe(before);
  });

  // Round 2: the disciplines load once on home, for the cards and the form's grouped select.
  it('hands the disciplines to the cards (home mode) and to the lead form', () => {
    const out = withHomeData(
      [
        { type: 'servicesOverview', props: { mode: 'page', disciplines: ['forged'] } },
        { type: 'contact', props: { groups: ['forged'] } },
        { type: 'aboutIntro' },
      ],
      { featured: cards, ctaHref: '/portfolio', disciplines },
    );
    // The mode is the route's — an authored `mode` in content cannot flip the home band
    // into page mode (links to #slug on a page without the explorer).
    expect(out[0]!.data).toEqual({ mode: 'home', disciplines });
    expect(out[0]!.props).toEqual({ mode: 'page', disciplines: ['forged'] });
    expect(out[1]!.data).toEqual({ groups: disciplines });
    expect(out[2]).toEqual({ type: 'aboutIntro' });
  });
});

describe('pickSelectedWork: among the featured projects only', () => {
  const pool = ['the-rider', 'kitchen-hours', 'notebook', 'ink'].map((slug) => ({ slug }));
  const slugs = (p: { featured: { slug: string }; cards: { slug: string }[] } | null) =>
    p && [p.featured.slug, ...p.cards.map((c) => c.slug)];

  it('defaults to the first featured project and the next two', () => {
    expect(slugs(pickSelectedWork(pool))).toEqual(['the-rider', 'kitchen-hours', 'notebook']);
  });

  it('honours an editor pick', () => {
    expect(slugs(pickSelectedWork(pool, { featuredSlug: 'ink', cardSlugs: ['notebook'] }))).toEqual(
      ['ink', 'notebook', 'the-rider'],
    );
  });

  it('ignores a stale pick instead of emptying the band', () => {
    expect(
      slugs(pickSelectedWork(pool, { featuredSlug: 'gone', cardSlugs: ['gone', 'ink', 'ink'] })),
    ).toEqual(['the-rider', 'ink', 'kitchen-hours']);
  });

  it('never repeats the featured project as a card', () => {
    expect(
      slugs(pickSelectedWork(pool, { featuredSlug: 'notebook', cardSlugs: ['notebook'] })),
    ).toEqual(['notebook', 'the-rider', 'kitchen-hours']);
  });

  it('works with fewer projects than the layout, and hides with none', () => {
    expect(slugs(pickSelectedWork(pool.slice(0, 1)))).toEqual(['the-rider']);
    expect(pickSelectedWork([])).toBeNull();
  });
});
