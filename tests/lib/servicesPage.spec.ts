import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  DEFAULT_SERVICES_SECTIONS,
  HERO_PRESETS,
  withHeroPreset,
  type SectionData,
} from '@/lib/sections/types';
import {
  EXPLORER_DISCIPLINE_TOKEN,
  SECTION_CONTENT_SCHEMAS,
  STAT_BAND_VARIANTS,
  ServiceExplorerSectionContentSchema,
  StatisticsSectionContentSchema,
  sectionContentIssues,
  type SectionType,
} from '@schemas/sections';
import { tierATags } from '@/lib/http/cacheTags';
import { PAGE_META } from '@/lib/seo/pageMeta';
import { SERVICES_PROOF_COPY } from '@/lib/services/proof';
import {
  EXPLORER_COPY,
  fallbackExplorerPanels,
  startLabelFor,
  toExplorerPanels,
  wrapIndex,
  type ExplorerDisciplineInput,
} from '@/lib/services/explorer';
import { FALLBACK_DISCIPLINES } from '@/lib/services/cards';
import { SERVICES_PROOF_SAMPLE_RATING, isSampleRating } from '@/lib/sections/samples';
import { rovingTabIndexes, tabIndexAfter, tabKeyMove } from '@/lib/client/tabs';
import { panelFromHash, rowClip } from '@/lib/client/serviceExplorer';
import { sameClip } from '@/lib/client/clips';
import { accentRange, splitAccent } from '@/lib/text/accent';
import { loadBlocks } from '../../scripts/gen-seeds.mjs';

// Round 2 (S3): the /services page — its default composition and seed, the hero preset,
// the proof band's content, the explorer's view model and its client helpers, and the
// route loader's guarantees.

const accented = (text: string, accent: Parameters<typeof accentRange>[0], locale: 'en' | 'ar') =>
  splitAccent(text, accentRange(accent, locale))
    .filter((r) => r.accent)
    .map((r) => r.text)
    .join('');

const t = (en: string) => ({ en, ar: `ع-${en}` });
const poster = (id: string) => ({
  id,
  src: { src: `/${id}.jpg`, width: 1600, height: 900, format: 'jpg' as const },
  width: 1600,
  height: 900,
  alt: { en: '', ar: '' },
});
const clip = (startS: number, endS: number) => ({ path: '/media/showreel.mp4', startS, endS });
const svc = (slug: string, over: Partial<ExplorerDisciplineInput['services'][number]> = {}) => ({
  slug,
  title: t(slug),
  poster: null,
  clip: null,
  ...over,
});
const disc = (slug: string, services: ExplorerDisciplineInput['services']) => ({
  slug,
  name: t(slug),
  blurb: t(`${slug} blurb`),
  poster: poster(slug),
  clip: clip(1, 3),
  services,
});

// ── The composition ───────────────────────────────────────────────────────────────

describe('the Services page composition', () => {
  const ORDER = ['hero', 'statistics', 'servicesOverview', 'serviceExplorer', 'hello'];

  it('is the design order: hero, proof, discipline cards, explorer, "Say hello"', () => {
    expect(DEFAULT_SERVICES_SECTIONS.map((s) => s.type)).toEqual(ORDER);
  });

  it('the proof band is the statistics `services` variant, and the code default carries NO rating', () => {
    // The rating is the design's sample claim. This default renders whenever the
    // composition is empty (unpublished page, every section hidden, a failed read), and code
    // is never behind the 0025 placeholder fence, so the claim may live only in the flagged
    // seed row.
    const proof = DEFAULT_SERVICES_SECTIONS.find((s) => s.type === 'statistics')!;
    expect(proof.props).toEqual({ variant: 'services', placement: 'services' });
    expect(JSON.stringify(DEFAULT_SERVICES_SECTIONS)).not.toContain('4.9');
  });

  it('the seeded composition is the default one plus the sample rating, on a flagged row', () => {
    type Row = {
      type: string;
      content: Record<string, unknown>;
      sort_order: number;
      is_placeholder?: boolean;
      __placeholder?: boolean;
    };
    const rows = (loadBlocks() as unknown as { table: string; rows: Row[] }[])
      .filter((b) => b.table === 'page_sections')
      .flatMap((b) => b.rows)
      .filter((r) => JSON.stringify(r).includes('"slug":"services"'))
      .sort((a, b) => a.sort_order - b.sort_order);
    expect(rows.map((r) => r.type)).toEqual(ORDER);
    for (const [i, row] of rows.entries()) {
      // The seed is the default, except that the proof row adds the design's sample rating.
      const { rating, ...content } = row.content;
      expect(content, row.type).toEqual(DEFAULT_SERVICES_SECTIONS[i]!.props ?? {});
      // Only the band carrying the rating line is a sample (production hides it until the
      // owner's override, runbook §6d); the rest is the design's own copy.
      const sample = row.type === 'statistics';
      expect(rating !== undefined, row.type).toBe(sample);
      expect(row.is_placeholder === true, row.type).toBe(sample);
      expect(row.__placeholder === true, row.type).toBe(sample);
    }
    const proof = rows.find((r) => r.type === 'statistics')!;
    expect(proof.content['rating']).toEqual({
      value: '4.9 / 5',
      label: { en: 'average client rating', ar: 'متوسط تقييم عملائنا' },
    });
    // …and it is the constant the admin's sample-rating guard refuses (Round 3), so the
    // seed and the guard cannot drift apart.
    expect(proof.content['rating']).toEqual(SERVICES_PROOF_SAMPLE_RATING);
    expect(isSampleRating(proof.content['rating'])).toBe(true);
  });

  it('isSampleRating: the sample value in any spelling, never a real rating or a non-object', () => {
    expect(isSampleRating(SERVICES_PROOF_SAMPLE_RATING)).toBe(true);
    expect(isSampleRating({ value: '4.9/5', label: { en: 'x', ar: 'y' } })).toBe(true);
    expect(isSampleRating({ value: ' 4.9 / 5 ', label: { en: 'reworded', ar: 'y' } })).toBe(true);
    expect(isSampleRating({ value: '4.8 / 5', label: SERVICES_PROOF_SAMPLE_RATING.label })).toBe(
      false,
    );
    expect(isSampleRating({ value: '4.9 / 10' })).toBe(false);
    expect(isSampleRating({ value: '' })).toBe(false);
    expect(isSampleRating({})).toBe(false);
    expect(isSampleRating(undefined)).toBe(false);
    expect(isSampleRating(null)).toBe(false);
    expect(isSampleRating('4.9 / 5')).toBe(false);
    expect(isSampleRating(['4.9 / 5'])).toBe(false);
  });

  it('seeds the services page itself, published', () => {
    const page = (loadBlocks() as unknown as { table: string; rows: Record<string, unknown>[] }[])
      .filter((b) => b.table === 'pages')
      .flatMap((b) => b.rows)
      .find((r) => r['slug'] === 'services');
    expect(page).toMatchObject({ status: 'published', title: { en: 'Services', ar: 'الخدمات' } });
  });

  it('every default section carries content its schema accepts', () => {
    for (const s of DEFAULT_SERVICES_SECTIONS) {
      const schema = SECTION_CONTENT_SCHEMAS[s.type as SectionType];
      if (!schema) continue;
      const parsed = schema.safeParse(s.props ?? {});
      expect(parsed.success, `${s.type}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  it('has its own head copy, EN and AR', () => {
    expect(PAGE_META.services.en.title).toBe('Services');
    expect(PAGE_META.services.en.description).toMatch(/^Branding, production, marketing/);
    expect(PAGE_META.services.ar.title).toBe('الخدمات');
    expect(PAGE_META.services.ar.description.length).toBeGreaterThan(40);
  });
});

// ── The hero preset ───────────────────────────────────────────────────────────────

describe("HERO_PRESETS.services — 'Ideas, made real'", () => {
  const { content, data } = HERO_PRESETS.services;

  it('accents "real" / "حقيقة" (the design\'s <em>)', () => {
    const word = (text: string, from: number) => text.split(/\s+/).slice(from).join(' ');
    expect(word(content.headline.en, content.accentFromEn)).toBe('real');
    expect(word(content.headline.ar, content.accentFromAr)).toBe('حقيقة');
  });

  it('is the banner at 13.4–15.9 s, its CTA to the cards and its alt link to the form', () => {
    expect(data).toMatchObject({
      banner: true,
      ctaHref: '#categories',
      clip: { start: 13.4, end: 15.9 },
      altLink: { href: '#inquiry' },
    });
    expect(data.altLink.label.en).toBe('Know what you need? <b>Skip to the inquiry</b>');
    expect(data.altLink.label.ar).toBe('عارف وش تحتاج؟ <b>انتقل للطلب مباشرة</b>');
  });

  it('applies to the first hero only, under authored copy', () => {
    const out = withHeroPreset(
      [{ type: 'hero', props: { ctaLabel: { en: 'Go', ar: 'يلا' } } }, { type: 'hero' }],
      'services',
    );
    expect(out[0]!.props).toMatchObject({ headline: content.headline, ctaLabel: { en: 'Go' } });
    expect(out[0]!.data).toMatchObject({ banner: true, ctaHref: '#categories' });
    expect(out[1]).toEqual({ type: 'hero' });
  });
});

// ── The proof band (statistics `services`) ─────────────────────────────────────────

describe('the statistics section, `services` variant', () => {
  it('is a variant and a placement the schema accepts', () => {
    expect(STAT_BAND_VARIANTS).toContain('services');
    const ok = StatisticsSectionContentSchema.safeParse({
      variant: 'services',
      placement: 'services',
      line: { en: 'A b c', ar: 'أ ب ج' },
      lineAccent: { en: { from: 2 } },
      rating: { value: '4.9 / 5', label: { en: 'average', ar: 'متوسط' } },
    });
    expect(ok.success, JSON.stringify(ok.error?.issues)).toBe(true);
  });

  it('refuses a rating that is not a short display value, or carries a stray key', () => {
    const bad = (rating: unknown) => sectionContentIssues('statistics', { rating });
    expect(bad({ value: '', label: { en: 'x', ar: 'س' } })).not.toEqual([]);
    expect(bad({ value: '4.9 out of five stars', label: { en: 'x', ar: 'س' } })).not.toEqual([]);
    expect(bad({ value: '4.9', label: { en: 'x' } })).not.toEqual([]); // AR required
    expect(bad({ value: '4.9', label: { en: 'x', ar: 'س' }, count: 120 })).not.toEqual([]);
  });

  it('the built-in statement accents "Zero handoffs." / "بدون تسليم لأحد."', () => {
    const { en, ar, accent } = SERVICES_PROOF_COPY;
    expect(accented(en.line, accent, 'en')).toBe('Zero handoffs.');
    expect(accented(ar.line, accent, 'ar')).toBe('بدون تسليم لأحد.');
  });
});

// ── The explorer section ───────────────────────────────────────────────────────────

describe('the serviceExplorer section content', () => {
  it('takes only its two labels (strict)', () => {
    expect(sectionContentIssues('serviceExplorer', {})).toEqual([]);
    expect(sectionContentIssues('serviceExplorer', { disciplines: [] })).not.toEqual([]);
    expect(
      sectionContentIssues('serviceExplorer', {
        inquireLabel: { en: 'Ask', ar: 'اسأل' },
        startLabel: { en: 'Begin {discipline}', ar: 'ابدأ {discipline}' },
      }),
    ).toEqual([]);
  });

  it('refuses a "Start your…" label that does not name the discipline, in either language', () => {
    const start = (en: string, ar: string) =>
      ServiceExplorerSectionContentSchema.safeParse({ startLabel: { en, ar } }).success;
    expect(start(`Go ${EXPLORER_DISCIPLINE_TOKEN}`, `يلا ${EXPLORER_DISCIPLINE_TOKEN}`)).toBe(true);
    expect(start('Start your project', `ابدأ ${EXPLORER_DISCIPLINE_TOKEN}`)).toBe(false);
    expect(start(`Start ${EXPLORER_DISCIPLINE_TOKEN}`, 'ابدأ مشروعك')).toBe(false);
  });
});

describe('toExplorerPanels', () => {
  const DISCIPLINES = [
    disc('branding', [
      svc('logo', { poster: poster('write'), clip: clip(5.9, 7.9) }),
      svc('business-cards'),
    ]),
    disc('production', [svc('motion-graphics')]),
    disc('events', [svc('venue-booking'), svc('3d-design'), svc('booth-production')]),
  ];

  it('numbers the panels, keys them by slug and counts their services', () => {
    const panels = toExplorerPanels(DISCIPLINES, 'en');
    expect(panels.map((p) => [p.slug, p.n, p.position, p.count])).toEqual([
      ['branding', '01', '01 / 03', '2 services'],
      ['production', '02', '02 / 03', '1 service'],
      ['events', '03', '03 / 03', '3 services'],
    ]);
    expect(panels[0]).toMatchObject({
      tabId: 'svc-tab-branding',
      headingId: 'svc-panel-branding-h',
      name: 'branding',
      blurb: 'branding blurb',
    });
  });

  it("counts in Arabic plural forms, Western digits (the cards' rule)", () => {
    const counts = toExplorerPanels(DISCIPLINES, 'ar').map((p) => p.count);
    expect(counts).toEqual(['2 خدمتان', '1 خدمة', '3 خدمات']);
  });

  it("links every service to its page and its page's form, locale-aware", () => {
    const [en] = toExplorerPanels(DISCIPLINES, 'en');
    expect(en!.services[0]).toMatchObject({
      n: '01',
      name: 'logo',
      href: '/services/logo',
      inquireHref: '/services/logo#inquiry',
      inquireLabel: 'Inquire: logo',
    });
    const [ar] = toExplorerPanels(DISCIPLINES, 'ar');
    expect(ar!.services[1]).toMatchObject({
      n: '02',
      name: 'ع-business-cards',
      href: '/ar/services/business-cards',
      inquireHref: '/ar/services/business-cards#inquiry',
      inquireLabel: 'اطلب: ع-business-cards',
    });
  });

  it("swaps to a service's own poster and window, else keeps the discipline's", () => {
    const [branding] = toExplorerPanels(DISCIPLINES, 'en');
    expect(branding!.services[0]!.poster?.id).toBe('write');
    expect(branding!.services[0]!.clip).toEqual(clip(5.9, 7.9));
    expect(branding!.services[1]!.poster?.id).toBe('branding');
    expect(branding!.services[1]!.clip).toEqual(clip(1, 3));
  });

  it('prev / next wrap around at both ends', () => {
    const panels = toExplorerPanels(DISCIPLINES, 'en');
    expect(panels[0]!.prev.slug).toBe('events');
    expect(panels[0]!.next.slug).toBe('production');
    expect(panels[2]!.next.slug).toBe('branding');
    expect(wrapIndex(0, -1, 5)).toBe(4);
    expect(wrapIndex(4, 1, 5)).toBe(0);
    expect(wrapIndex(2, 1, 0)).toBe(0);
  });

  it('closes each panel with "Start your {Discipline} project", or the authored label', () => {
    expect(toExplorerPanels(DISCIPLINES, 'en')[1]!.startLabel).toBe(
      'Start your production project',
    );
    expect(toExplorerPanels(DISCIPLINES, 'ar')[1]!.startLabel).toBe('ابدأ مشروع ع-production');
    expect(startLabelFor('Branding', 'en', `Let's do {discipline}`)).toBe("Let's do Branding");
    expect(EXPLORER_COPY.en.inquire).toBe('Inquire');
    expect(EXPLORER_COPY.ar.inquire).toBe('اطلب');
    const custom = toExplorerPanels(DISCIPLINES, 'en', { inquire: 'Ask' });
    expect(custom[0]!.services[0]!.inquireLabel).toBe('Ask: logo');
  });

  it("the outage fallback is the five disciplines as text, with the cards' slugs", () => {
    const panels = fallbackExplorerPanels('en');
    expect(panels.map((p) => p.slug)).toEqual(FALLBACK_DISCIPLINES.map((d) => d.slug));
    expect(panels.every((p) => p.count === null && p.services.length === 0)).toBe(true);
    expect(panels.every((p) => p.poster === null && p.clip === null)).toBe(true);
    expect(panels[4]).toMatchObject({
      position: '05 / 05',
      startLabel: 'Start your Events & Exhibitions project',
    });
  });
});

// ── Client helpers (pure parts) ────────────────────────────────────────────────────

describe('tabs (APG, automatic activation)', () => {
  it('maps arrows to reading order — mirrored in RTL — and Home/End to the ends', () => {
    expect(tabKeyMove('ArrowRight', false)).toBe('next');
    expect(tabKeyMove('ArrowLeft', false)).toBe('prev');
    expect(tabKeyMove('ArrowRight', true)).toBe('prev');
    expect(tabKeyMove('ArrowLeft', true)).toBe('next');
    expect(tabKeyMove('Home', true)).toBe('first');
    expect(tabKeyMove('End', false)).toBe('last');
    expect(tabKeyMove('ArrowDown', false)).toBeNull();
    expect(tabKeyMove('Tab', false)).toBeNull();
  });

  it('wraps at both ends', () => {
    expect(tabIndexAfter(4, 'next', 5)).toBe(0);
    expect(tabIndexAfter(0, 'prev', 5)).toBe(4);
    expect(tabIndexAfter(2, 'first', 5)).toBe(0);
    expect(tabIndexAfter(2, 'last', 5)).toBe(4);
    expect(tabIndexAfter(1, 'next', 5)).toBe(2);
    expect(tabIndexAfter(0, 'next', 0)).toBe(0);
  });

  it('keeps exactly one tab in the Tab sequence (roving tabindex)', () => {
    expect(rovingTabIndexes(4, 2)).toEqual([-1, -1, 0, -1]);
    expect(rovingTabIndexes(3, null)).toEqual([0, -1, -1]);
    expect(rovingTabIndexes(3, 7)).toEqual([0, -1, -1]);
  });
});

describe('the explorer script', () => {
  const SLUGS = ['branding', 'production', 'events'];

  it('opens only a panel the fragment names', () => {
    expect(panelFromHash('#events', SLUGS)).toBe('events');
    expect(panelFromHash('events', SLUGS)).toBe('events');
    expect(panelFromHash('#inquiry', SLUGS)).toBeNull();
    expect(panelFromHash('', SLUGS)).toBeNull();
    expect(panelFromHash('#%E0%A4%A', SLUGS)).toBeNull(); // malformed escape
  });

  it("reads a row's clip window from its data attributes", () => {
    expect(
      rowClip({ xpClipSrc: '/media/showreel.mp4', xpClipStart: '5.9', xpClipEnd: '7.9' }),
    ).toEqual({ src: '/media/showreel.mp4', start: 5.9, end: 7.9 });
    expect(rowClip({})).toBeNull();
    expect(rowClip({ xpClipSrc: '/media/a.mp4', xpClipStart: 'x' })).toEqual({
      src: '/media/a.mp4',
      start: undefined,
      end: undefined,
    });
  });

  it('retargets a clip frame only when the window really changes', () => {
    const data = { clipSrc: '/media/showreel.mp4', clipStart: '1', clipEnd: '3' };
    expect(sameClip(data, { src: '/media/showreel.mp4', start: 1, end: 3 })).toBe(true);
    expect(sameClip(data, { src: '/media/showreel.mp4', start: 5.9, end: 7.9 })).toBe(false);
    expect(sameClip(data, { src: '/media/other.mp4', start: 1, end: 3 })).toBe(false);
  });
});

// ── The route loader ───────────────────────────────────────────────────────────────

let authored: SectionData[] = [];
let published = true;
let disciplineCalls = 0;
const DISCIPLINES_ROWS = [{ slug: 'branding' }, { slug: 'events' }];
vi.mock('@/lib/data/pageSections', () => ({
  getPageComposition: async (slug: string) =>
    published
      ? { page: { id: `id-${slug}`, slug, title: t(slug), updatedAt: null }, sections: authored }
      : null,
}));
vi.mock('@/lib/data/disciplines', () => ({
  getPublishedDisciplines: async () => {
    disciplineCalls++;
    return DISCIPLINES_ROWS;
  },
}));
const entities: unknown[] = [];
vi.mock('@/lib/seo/head', () => ({
  loadHead: async (_locals: unknown, opts: { fallbackTitle: string; entity: unknown }) => {
    entities.push(await opts.entity);
    return { seo: { title: opts.fallbackTitle }, identity: {}, brand: 'B' };
  },
}));

const {
  SERVICES_CACHE_ENTITIES,
  composeServicesPage,
  ensureServiceExplorer,
  loadServicesPage,
  servicesPageLinks,
  withServicesData,
} = await import('@/lib/services/servicesPage');
const byType = (sections: SectionData[], type: string) => sections.find((s) => s.type === type);

beforeEach(() => {
  authored = [];
  published = true;
  disciplineCalls = 0;
  entities.length = 0;
});

describe('servicesPageLinks', () => {
  it("points the CTA at the cards and the inquiries at this page's form", () => {
    expect(servicesPageLinks(DEFAULT_SERVICES_SECTIONS)).toEqual({
      ctaHref: '#categories',
      inquiryHref: '#inquiry',
    });
  });

  it("falls back to the contact form when this page's is hidden, and the CTA with it", () => {
    const noHello = DEFAULT_SERVICES_SECTIONS.map((s) =>
      s.type === 'hello' ? { ...s, visible: false } : s,
    );
    expect(servicesPageLinks(noHello).inquiryHref).toBe('/contact#inquiry');
    const neither = noHello.filter((s) => s.type !== 'servicesOverview');
    expect(servicesPageLinks(neither).ctaHref).toBe('/contact#inquiry');
  });

  it('with the cards hidden, the CTA goes to the standalone explorer, when there is one', () => {
    const noCards = DEFAULT_SERVICES_SECTIONS.filter((s) => s.type !== 'servicesOverview');
    expect(servicesPageLinks(noCards, 'branding').ctaHref).toBe('#branding');
    // No explorer on the page (or no discipline to open): the form, as before.
    const bare = noCards.filter((s) => s.type !== 'serviceExplorer');
    expect(servicesPageLinks(bare, 'branding').ctaHref).toBe('#inquiry');
    expect(servicesPageLinks(noCards).ctaHref).toBe('#inquiry');
    // With the cards, they stay the target.
    expect(servicesPageLinks(DEFAULT_SERVICES_SECTIONS, 'branding').ctaHref).toBe('#categories');
  });
});

describe('ensureServiceExplorer', () => {
  it('shows a hidden explorer while the cards (its links) show', () => {
    const out = ensureServiceExplorer([
      { type: 'servicesOverview' },
      { type: 'serviceExplorer', visible: false },
    ]);
    expect(byType(out, 'serviceExplorer')?.visible).toBe(true);
  });

  it('puts a removed explorer back right after the cards', () => {
    const out = ensureServiceExplorer([
      { type: 'hero' },
      { type: 'servicesOverview' },
      { type: 'hello' },
    ]);
    expect(out.map((s) => s.type)).toEqual([
      'hero',
      'servicesOverview',
      'serviceExplorer',
      'hello',
    ]);
  });

  it("leaves the editor's choice alone when the cards are hidden", () => {
    const input: SectionData[] = [
      { type: 'servicesOverview', visible: false },
      { type: 'serviceExplorer', visible: false },
    ];
    expect(ensureServiceExplorer(input)).toEqual(input);
  });
});

describe('withServicesData', () => {
  it('hands the disciplines to the cards (page mode), the explorer and the form', () => {
    const d = [{ slug: 'branding' }];
    const out = withServicesData(withHeroPreset(DEFAULT_SERVICES_SECTIONS, 'services'), {
      disciplines: d,
    });
    expect(byType(out, 'servicesOverview')?.data).toEqual({ mode: 'page', disciplines: d });
    expect(byType(out, 'serviceExplorer')?.data).toEqual({
      disciplines: d,
      inquiryHref: '#inquiry',
      standalone: false,
    });
    expect(byType(out, 'hello')?.data).toEqual({ groups: d });
    expect(byType(out, 'hero')?.data).toMatchObject({
      ctaHref: '#categories',
      altLink: { href: '#inquiry' },
    });
  });

  it('makes the explorer standalone when no card band shows, and points the CTA at it', () => {
    // With the cards hidden nothing else on the page opens the explorer: it must show its
    // first panel from first paint (services.css), or a bare /services visit sees none of
    // the 28 service links.
    for (const cards of [{ visible: false }, null] as const) {
      const sections = DEFAULT_SERVICES_SECTIONS.flatMap((s) =>
        s.type !== 'servicesOverview' ? [s] : cards ? [{ ...s, ...cards }] : [],
      );
      const out = withServicesData(ensureServiceExplorer(withHeroPreset(sections, 'services')), {
        disciplines: [{ slug: 'branding' }, { slug: 'events' }],
      });
      expect(byType(out, 'serviceExplorer')?.data).toMatchObject({ standalone: true });
      expect(byType(out, 'hero')?.data).toMatchObject({ ctaHref: '#branding' });
    }
  });

  it('re-points the hero when its bands are hidden', () => {
    const composed = withHeroPreset(
      DEFAULT_SERVICES_SECTIONS.map((s) =>
        s.type === 'hello' || s.type === 'servicesOverview' ? { ...s, visible: false } : s,
      ),
      'services',
    );
    const hero = byType(withServicesData(composed, { disciplines: [] }), 'hero');
    expect(hero?.data).toMatchObject({
      ctaHref: '/contact#inquiry',
      altLink: { href: '/contact#inquiry' },
    });
  });
});

describe('loadServicesPage', () => {
  it('renders the default composition until the page is composed, with ONE disciplines load', async () => {
    const page = await loadServicesPage({} as never, 'en');
    expect(page.sections.map((s) => s.type)).toEqual(DEFAULT_SERVICES_SECTIONS.map((s) => s.type));
    expect(disciplineCalls).toBe(1);
    for (const type of ['servicesOverview', 'serviceExplorer']) {
      expect(byType(page.sections, type)?.data?.['disciplines'], type).toBe(DISCIPLINES_ROWS);
    }
    expect(byType(page.sections, 'hello')?.data?.['groups']).toBe(DISCIPLINES_ROWS);
    expect(page.header).toBe('overlay');
    expect(page.hiddenH1).toBe(false);
    expect(entities).toEqual([{ type: 'page', id: 'id-services' }]);
  });

  it('renders the authored composition, with the banner preset on its hero', async () => {
    authored = [{ type: 'hero' }, { type: 'serviceExplorer' }, { type: 'hello' }];
    const page = await loadServicesPage({} as never, 'ar');
    expect(page.sections.map((s) => s.type)).toEqual(['hero', 'serviceExplorer', 'hello']);
    expect(byType(page.sections, 'hero')?.props).toMatchObject({
      headline: HERO_PRESETS.services.content.headline,
    });
  });

  it('opens on a solid header, with a hidden h1, when an editor hides the hero', async () => {
    authored = [{ type: 'hero', visible: false }, { type: 'statistics' }, { type: 'hello' }];
    const page = await loadServicesPage({} as never, 'en');
    expect(page.header).toBe('solid');
    expect(page.hiddenH1).toBe(true);
  });

  it('an unpublished page still renders (the default) and asks for no page SEO row', async () => {
    published = false;
    const page = await loadServicesPage({} as never, 'en');
    expect(page.sections.length).toBe(DEFAULT_SERVICES_SECTIONS.length);
    expect(entities).toEqual([null]);
    // The fallback reaches production unflagged, so it must not carry the sample rating.
    expect(byType(page.sections, 'statistics')?.props).not.toHaveProperty('rating');
  });

  it('carries the Home › Services breadcrumb, localized', async () => {
    const page = await loadServicesPage({} as never, 'ar');
    const crumb = JSON.stringify(page.jsonLd);
    expect(crumb).toContain('BreadcrumbList');
    expect(crumb).toContain('https://www.braiinstation.com/ar/services');
    expect(crumb).toContain('الخدمات');
    expect(crumb).not.toContain('AggregateRating');
  });

  it('composeServicesPage never mutates the default composition', () => {
    const before = JSON.stringify(DEFAULT_SERVICES_SECTIONS);
    composeServicesPage([], []);
    expect(JSON.stringify(DEFAULT_SERVICES_SECTIONS)).toBe(before);
  });

  it('its cache tags cover every table the page reads, within the purge limit', () => {
    const tags = tierATags({ route: 'services', locale: 'en', entities: SERVICES_CACHE_ENTITIES });
    for (const tag of [
      'page:services',
      'services:all',
      'disciplines:all',
      'statistics:all',
      'media:all',
      'route:services',
    ]) {
      expect(tags).toContain(tag);
    }
    expect(tags.length).toBeLessThanOrEqual(30);
  });
});
