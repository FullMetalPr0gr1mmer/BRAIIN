import { describe, expect, it } from 'vitest';
import {
  HELLO_MAX_POINTS,
  HelloSectionContentSchema,
  ServicesOverviewSectionContentSchema,
  sectionContentIssues,
} from '@schemas/sections';
import {
  DISCIPLINE_BAND_COPY,
  FALLBACK_DISCIPLINES,
  disciplineHref,
  disciplineSectionId,
  fallbackDisciplineCards,
  serviceCount,
  toDisciplineCards,
  type DisciplineCardInput,
} from '@/lib/services/cards';
import { HELLO_COPY, SERVICE_HELLO_LEAD, serviceHelloHeading } from '@/lib/sections/hello';
import { heroText, splitBold } from '@/lib/text/heroLinks';
import { accentRange, splitAccent } from '@/lib/text/accent';
import { loadBlocks } from '../../scripts/gen-seeds.mjs';

// Round 2 (S2): the discipline cards' view model, the "Say hello" copy and schema, and the
// hero's new link text. Pure modules — the components render exactly what these return.

const accented = (text: string, accent: Parameters<typeof accentRange>[0], locale: 'en' | 'ar') =>
  splitAccent(text, accentRange(accent, locale))
    .filter((r) => r.accent)
    .map((r) => r.text)
    .join('');

const pair = { en: 'Two words', ar: 'كلمتان هنا' };

describe('discipline cards', () => {
  const input: DisciplineCardInput[] = [
    {
      slug: 'branding',
      name: { en: 'Branding', ar: 'الهوية البصرية' },
      short: { en: 'The mark.', ar: 'الشعار.' },
      poster: null,
      clip: null,
      services: Array.from({ length: 8 }),
    },
    {
      slug: 'web',
      name: { en: 'Website Development' },
      short: null,
      poster: null,
      clip: null,
      services: Array.from({ length: 3 }),
    },
  ];

  it('home cards link to the /services explorer, locale-aware, numbered from 01', () => {
    const en = toDisciplineCards(input, 'home', 'en');
    expect(en.map((c) => [c.n, c.href, c.name, c.count])).toEqual([
      ['01', '/services#branding', 'Branding', '8 services'],
      ['02', '/services#web', 'Website Development', '3 services'],
    ]);
    const ar = toDisciplineCards(input, 'home', 'ar');
    expect(ar[0]).toMatchObject({ href: '/ar/services#branding', name: 'الهوية البصرية' });
    // A missing Arabic name reads English (EN is x-default), never blank.
    expect(ar[1]!.name).toBe('Website Development');
    expect(ar[1]!.short).toBe('');
  });

  it('page cards link to their panel on the same page', () => {
    expect(disciplineHref('events', 'page', 'ar')).toBe('#events');
    expect(toDisciplineCards(input, 'page', 'en').map((c) => c.href)).toEqual([
      '#branding',
      '#web',
    ]);
  });

  it('the band keeps the /#services deep link on home; /services names it categories', () => {
    expect(disciplineSectionId('home')).toBe('services');
    expect(disciplineSectionId('page')).toBe('categories');
  });

  it('counts follow the Arabic plural categories, in Western digits (the digit rule)', () => {
    expect(serviceCount(1, 'en')).toBe('1 service');
    expect(serviceCount(8, 'en')).toBe('8 services');
    expect(serviceCount(1, 'ar')).toBe('1 خدمة');
    expect(serviceCount(2, 'ar')).toBe('2 خدمتان');
    expect(serviceCount(8, 'ar')).toBe('8 خدمات');
    expect(serviceCount(11, 'ar')).toBe('11 خدمةً');
    expect(serviceCount(100, 'ar')).toBe('100 خدمة');
  });

  it('the outage fallback is the five disciplines as text: no counts, no media', () => {
    const cards = fallbackDisciplineCards('home', 'en');
    expect(cards.map((c) => c.slug)).toEqual([
      'branding',
      'production',
      'marketing',
      'web',
      'events',
    ]);
    for (const c of cards) {
      expect(c.count).toBeNull();
      expect(c.poster).toBeNull();
      expect(c.clip).toBeNull();
    }
    expect(fallbackDisciplineCards('page', 'ar')[4]).toMatchObject({
      n: '05',
      href: '#events',
      name: 'الفعاليات والمعارض',
    });
  });

  it('the fallback carries the seeded disciplines’ words (the design copy)', () => {
    type Row = { slug: string; name: unknown; short: unknown; sort_order: number };
    const rows = (loadBlocks() as unknown as { table: string; rows: Row[] }[])
      .filter((b) => b.table === 'disciplines')
      .flatMap((b) => b.rows)
      .sort((a, b) => a.sort_order - b.sort_order);
    expect(rows.map((r) => ({ slug: r.slug, name: r.name, short: r.short }))).toEqual(
      FALLBACK_DISCIPLINES.map((d) => ({ slug: d.slug, name: d.name, short: d.short })),
    );
  });

  it('the built-in headings accent the mockup’s words', () => {
    const { home, page } = DISCIPLINE_BAND_COPY;
    expect(accented(home.en.heading, home.accent, 'en')).toBe('one studio');
    expect(accented(home.ar.heading, home.accent, 'ar')).toBe('استوديو واحد');
    expect(accented(page.en.heading, page.accent, 'en')).toBe('needs');
    expect(accented(page.ar.heading, page.accent, 'ar')).toBe('علامتك');
    // Only home closes with the "All services" button.
    expect(home.en.allLabel).toBe('All services');
    expect(page.en.allLabel).toBeNull();
  });
});

describe('servicesOverview content (strict since Round 2)', () => {
  it('accepts every override, and the production row {}', () => {
    expect(ServicesOverviewSectionContentSchema.safeParse({}).success).toBe(true);
    expect(
      ServicesOverviewSectionContentSchema.safeParse({
        tag: pair,
        heading: pair,
        accent: { en: { from: 1 } },
        sub: pair,
        hint: pair,
        allLabel: pair,
      }).success,
    ).toBe(true);
  });

  it('refuses a stray key — the route decides the mode and the disciplines', () => {
    expect(sectionContentIssues('servicesOverview', { mode: 'page' })).not.toEqual([]);
    expect(sectionContentIssues('servicesOverview', { disciplines: [] })).not.toEqual([]);
  });
});

describe('"Say hello"', () => {
  it('its content takes up to three points and nothing the route owns', () => {
    const points = [{ text: pair }, { text: pair }, { text: pair }];
    expect(HelloSectionContentSchema.safeParse({ tag: pair, heading: pair, points }).success).toBe(
      true,
    );
    expect(
      HelloSectionContentSchema.safeParse({ points: [...points, { text: pair }] }).success,
    ).toBe(false);
    expect(HELLO_MAX_POINTS).toBe(3);
    for (const stray of ['selected', 'groups', 'headingOverride', 'kind']) {
      expect(sectionContentIssues('hello', { [stray]: 'x' }), stray).not.toEqual([]);
    }
  });

  it('the built-in heading accents "hello" / "هلا", with three points in each language', () => {
    expect(accented(HELLO_COPY.en.heading, HELLO_COPY.accent, 'en')).toBe('hello');
    expect(accented(HELLO_COPY.ar.heading, HELLO_COPY.accent, 'ar')).toBe('هلا');
    expect(HELLO_COPY.en.points).toHaveLength(3);
    expect(HELLO_COPY.ar.points).toHaveLength(3);
  });

  it('a service page talks about its service — the accent is the service name', () => {
    const en = serviceHelloHeading('Logo Design', 'en');
    expect(en.text).toBe("Let's talk Logo Design");
    expect(accented(en.text, en.accent, 'en')).toBe('Logo Design');
    const ar = serviceHelloHeading('تصميم الشعار', 'ar');
    expect(ar.text).toBe('خلّنا نتكلم عن تصميم الشعار');
    expect(accented(ar.text, ar.accent, 'ar')).toBe('تصميم الشعار');
    expect(SERVICE_HELLO_LEAD.en).toMatch(/^Tell us what you need/);
  });
});

describe('hero link text', () => {
  it('picks the page language from a pair, and takes a plain string as is', () => {
    expect(heroText({ en: 'Services', ar: 'الخدمات' }, 'ar')).toBe('الخدمات');
    expect(heroText({ en: 'Services' }, 'ar')).toBe('Services');
    expect(heroText('Branding', 'en')).toBe('Branding');
  });

  it('bolds only a <b> run, and never lets another tag through as markup', () => {
    expect(splitBold('Know what you need? <b>Skip to the inquiry</b>')).toEqual([
      { text: 'Know what you need? ', bold: false },
      { text: 'Skip to the inquiry', bold: true },
    ]);
    expect(splitBold('عارف وش تحتاج؟ <b dir="ltr">انتقل للطلب مباشرة</b>')).toEqual([
      { text: 'عارف وش تحتاج؟ ', bold: false },
      { text: 'انتقل للطلب مباشرة', bold: true },
    ]);
    // Anything else stays TEXT — Astro escapes it on render.
    expect(splitBold('<img src=x onerror=alert(1)> hi')).toEqual([
      { text: '<img src=x onerror=alert(1)> hi', bold: false },
    ]);
    expect(splitBold('open <b>to the end')).toEqual([
      { text: 'open ', bold: false },
      { text: 'to the end', bold: true },
    ]);
    expect(splitBold('plain')).toEqual([{ text: 'plain', bold: false }]);
  });
});
