import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CaseMedia, CaseStudy, PortfolioCard } from '@/lib/data/portfolio';
import type { Testimonial } from '@/lib/data/taxonomy';
import type { ImageRef } from '@/lib/media/resolve';

// The case study (UI v2 PR11): the pure decisions (src/lib/portfolio/caseStudy.ts), the
// lightbox's stepping rules (src/lib/client/lightbox.ts) and the page loader
// (src/lib/portfolio/casePage.ts) — a real 404 for an unknown slug, "Next project" in
// catalogue order, the quote only when the project has one, the head reads started with
// the content query (not after it).

const t = (en: string) => ({ en, ar: `ع-${en}` });
const card = (id: string, over: Partial<PortfolioCard> = {}): PortfolioCard => ({
  id,
  slug: id,
  title: t(id),
  projectType: null,
  blurb: null,
  year: 2025,
  isFeatured: false,
  sortOrder: 1,
  updatedAt: null,
  poster: null,
  preview: null,
  sector: null,
  client: null,
  confidentialClient: false,
  services: [],
  ...over,
});
const study = (over: Partial<CaseStudy> = {}): CaseStudy => ({
  ...card('the-rider', { projectType: t('Brand film') }),
  summary: { en: 'The brief was…', ar: 'كان البريف…' },
  bodyHtml: null,
  lead: t('A launch film…'),
  goal: null,
  result: null,
  scope: [],
  keywords: [],
  results: [],
  nextPortfolioId: null,
  hero: null,
  final: null,
  breakdown: [],
  gallery: [],
  ...over,
});
const image = (alt: { en: string; ar: string }): ImageRef => ({
  id: '55555555-5555-4555-8555-555555555555',
  src: { src: '/_astro/g01.jpg', width: 1600, height: 900, format: 'jpg' },
  width: 1600,
  height: 900,
  alt,
});
const still = (over: Partial<CaseMedia> = {}): CaseMedia => ({
  kind: 'image',
  image: image({ en: 'A rider at dawn', ar: 'راكب عند الفجر' }),
  clip: null,
  durationLabel: null,
  caption: null,
  breakdownKind: null,
  layout: null,
  ...over,
});

// ── page-loader mocks ─────────────────────────────────────────────────────────────
let studies: Record<string, CaseStudy> = {};
let cards: PortfolioCard[] = [];
let quotes: Testimonial[] = [];
const calls: string[] = [];
vi.mock('@/lib/data/portfolio', () => ({
  getCaseStudy: async (slug: string) => {
    calls.push(`study:${slug}`);
    return studies[slug] ?? null;
  },
  getPortfolioCards: async () => {
    calls.push('cards');
    return cards;
  },
}));
vi.mock('@/lib/data/taxonomy', () => ({
  getTestimonials: async (opts: { portfolioId?: string; limit?: number }) => {
    calls.push(`quotes:${opts.portfolioId}:${opts.limit}`);
    return quotes;
  },
}));
const heads: { title: string; description: string | undefined; entity: unknown }[] = [];
vi.mock('@/lib/seo/head', () => ({
  loadHead: async (
    _locals: unknown,
    opts: {
      fallbackTitle: string | Promise<string>;
      fallbackDescription?: string | Promise<string>;
      entity: unknown;
    },
  ) => {
    calls.push('head');
    const [title, description, entity] = await Promise.all([
      opts.fallbackTitle,
      opts.fallbackDescription,
      opts.entity,
    ]);
    heads.push({ title, description, entity });
    return { seo: { title }, identity: {}, brand: 'B' };
  },
}));

const { nextProject, caseKeywords, describable, stillAlt, stillsCount, pad2 } =
  await import('@/lib/portfolio/caseStudy');
const { stepIndex, arrowDelta, counterLabel, isPlainClick } = await import('@/lib/client/lightbox');
const { loadCaseStudyPage, caseTitle, caseDescription, caseSchemaDescription } =
  await import('@/lib/portfolio/casePage');
const { buildCreativeWorkSchema } = await import('@/lib/seo/jsonld');

beforeEach(() => {
  studies = {};
  cards = [];
  quotes = [];
  calls.length = 0;
  heads.length = 0;
});

describe('nextProject — the "Next project" band', () => {
  const list = [card('a'), card('b'), card('c')];

  it('is the next project in catalogue order, wrapping from the last to the first', () => {
    expect(nextProject(list, { id: 'a', nextPortfolioId: null })?.id).toBe('b');
    expect(nextProject(list, { id: 'c', nextPortfolioId: null })?.id).toBe('a');
  });

  it('honours the editor’s pick when it is another published project', () => {
    expect(nextProject(list, { id: 'a', nextPortfolioId: 'c' })?.id).toBe('c');
  });

  it('ignores a pick that is unpublished (not in the list) or the project itself', () => {
    expect(nextProject(list, { id: 'a', nextPortfolioId: 'gone' })?.id).toBe('b');
    expect(nextProject(list, { id: 'a', nextPortfolioId: 'a' })?.id).toBe('b');
  });

  it('is null when there is nothing else to go to', () => {
    expect(nextProject([card('a')], { id: 'a', nextPortfolioId: null })).toBeNull();
    expect(nextProject([], { id: 'a', nextPortfolioId: null })).toBeNull();
  });

  it('falls back to the first project when the current one is not in the list', () => {
    expect(nextProject(list, { id: 'x', nextPortfolioId: null })?.id).toBe('a');
  });
});

describe('caseKeywords — the title band chips', () => {
  it('uses the authored keywords, in order', () => {
    const kw = [t('Brand film'), t('Launch')];
    expect(caseKeywords(study({ keywords: kw }))).toEqual(kw);
  });
  it('falls back to the project type alone (the mockup’s rule), else nothing', () => {
    expect(caseKeywords(study())).toEqual([t('Brand film')]);
    expect(caseKeywords(study({ projectType: null }))).toEqual([]);
  });
});

describe('describable / stillAlt — stills are content, alt is required', () => {
  it('keeps a still with a bilingual alt, or with a caption', () => {
    expect(describable(still())).toBe(true);
    expect(
      describable(still({ image: image({ en: '', ar: '' }), caption: t('First sketch') })),
    ).toBe(true);
  });
  it('drops a still with no image, or one described in only one language and uncaptioned', () => {
    expect(describable(still({ image: null }))).toBe(false);
    expect(describable(still({ image: image({ en: 'Only English', ar: '' }) }))).toBe(false);
    expect(describable(still({ image: image({ en: '', ar: '' }) }))).toBe(false);
  });
  it('alt is the still’s own description first, its caption second', () => {
    expect(stillAlt(still(), 'ar')).toBe('راكب عند الفجر');
    const captioned = still({ image: image({ en: '', ar: '' }), caption: t('First sketch') });
    expect(stillAlt(captioned, 'en')).toBe('First sketch');
    expect(stillAlt(captioned, 'ar')).toBe('ع-First sketch');
  });
});

describe('stillsCount — the gallery count', () => {
  it('pads like the mockup ("09 stills") and follows English plurals', () => {
    expect(stillsCount(9, 'en')).toBe('09 stills');
    expect(stillsCount(1, 'en')).toBe('01 still');
  });
  it('follows the Arabic plural categories (the mockup wrote لقطة for every count)', () => {
    expect(stillsCount(1, 'ar')).toBe('01 لقطة');
    expect(stillsCount(2, 'ar')).toBe('02 لقطتان');
    expect(stillsCount(9, 'ar')).toBe('09 لقطات');
    expect(stillsCount(12, 'ar')).toBe('12 لقطةً');
  });
  it('pad2 is the scope numbering', () => {
    expect(pad2(1)).toBe('01');
    expect(pad2(12)).toBe('12');
  });
});

describe('lightbox stepping', () => {
  it('wraps both ways', () => {
    expect(stepIndex(8, 1, 9)).toBe(0);
    expect(stepIndex(0, -1, 9)).toBe(8);
    expect(stepIndex(3, 0, 9)).toBe(3);
    expect(stepIndex(0, 1, 0)).toBe(0);
  });
  it('mirrors the arrow keys in RTL (ArrowLeft moves forward in Arabic)', () => {
    expect(arrowDelta('ArrowRight', false)).toBe(1);
    expect(arrowDelta('ArrowLeft', false)).toBe(-1);
    expect(arrowDelta('ArrowRight', true)).toBe(-1);
    expect(arrowDelta('ArrowLeft', true)).toBe(1);
    expect(arrowDelta('Enter', false)).toBe(0);
  });
  it('counts like the mockup ("03 / 09")', () => {
    expect(counterLabel(2, 9)).toBe('03 / 09');
  });
  it('leaves modified and non-primary clicks to the browser (new tab, download)', () => {
    const plain = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
    expect(isPlainClick(plain)).toBe(true);
    expect(isPlainClick({ ...plain, ctrlKey: true })).toBe(false);
    expect(isPlainClick({ ...plain, metaKey: true })).toBe(false);
    expect(isPlainClick({ ...plain, button: 1 })).toBe(false);
  });
});

describe('caseTitle / caseDescription — the head', () => {
  it('title is "name | type" (the mockup’s document.title), or the name alone', () => {
    expect(caseTitle(study(), 'en')).toBe('the-rider | Brand film');
    expect(caseTitle(study({ projectType: null }), 'ar')).toBe('ع-the-rider');
  });
  it('description: teaser, else summary — strictly in the page language — else the generic line', () => {
    expect(caseDescription(study({ blurb: t('A launch film shot at dawn.') }), 'en')).toBe(
      'A launch film shot at dawn.',
    );
    expect(caseDescription(study(), 'ar')).toBe('كان البريف…');
    const englishOnly = study({ summary: { en: 'English only' } });
    expect(caseDescription(englishOnly, 'ar')).toBe(
      'دراسة حالة من %brand%: البريف، ونطاق العمل، والنتيجة، وكيف انصنع الشغل.',
    );
    expect(caseDescription(study({ summary: null }), 'en')).toContain('A %brand% case study');
  });
  it('the CreativeWork description never ships the raw %brand% token (no teaser, no summary)', () => {
    for (const [s, locale] of [
      [study({ summary: null }), 'en'],
      [study({ summary: { en: 'English only' } }), 'ar'],
    ] as const) {
      const node = buildCreativeWorkSchema({
        name: 'The Rider',
        description: caseSchemaDescription(s, locale, 'Acme Studio'),
        url: 'https://www.braiinstation.com/portfolio/the-rider',
        org: { name: 'Acme Studio' },
      });
      expect(JSON.stringify(node)).not.toContain('%brand%');
      expect(node.description).toContain('Acme Studio');
    }
    // a real teaser passes through untouched
    expect(caseSchemaDescription(study({ blurb: t('Dawn.') }), 'en', 'B')).toBe('Dawn.');
  });
});

describe('loadCaseStudyPage', () => {
  it('is null for an unknown or unpublished slug (the route answers a real 404)', async () => {
    cards = [card('the-rider')];
    expect(await loadCaseStudyPage('nope', {}, 'en')).toBeNull();
    // no quote lookup for a project that does not exist
    expect(calls.some((c) => c.startsWith('quotes:'))).toBe(false);
  });

  it('assembles the study, the next project and the project’s own quote', async () => {
    const q: Testimonial = {
      slug: 'quote-the-rider',
      quote: t('They came back with a film…'),
      authorName: t('Client name'),
      authorRole: t('Marketing Director, Company'),
      avatar: null,
    };
    studies = { 'the-rider': study() };
    cards = [card('the-rider'), card('kitchen-hours')];
    quotes = [q];
    const page = await loadCaseStudyPage('the-rider', {}, 'en');
    expect(page?.study.slug).toBe('the-rider');
    expect(page?.next?.slug).toBe('kitchen-hours');
    expect(page?.quote).toEqual(q);
    expect(calls).toContain('quotes:the-rider:1');
    expect(heads[0]).toEqual({
      title: 'the-rider | Brand film',
      description: 'The brief was…',
      entity: { type: 'portfolio', id: 'the-rider' },
    });
  });

  it('hides the quote when the project has no published testimonial', async () => {
    studies = { 'the-rider': study() };
    const page = await loadCaseStudyPage('the-rider', {}, 'ar');
    expect(page?.quote).toBeNull();
    expect(page?.next).toBeNull();
  });

  it('starts the cards and head reads with the case-study query, not after it', async () => {
    studies = { 'the-rider': study() };
    await loadCaseStudyPage('the-rider', {}, 'en');
    // cards + head are called synchronously alongside the study query; only the quote
    // lookup waits for it
    expect(calls.slice(0, 3).sort()).toEqual(['cards', 'head', 'study:the-rider']);
  });
});
