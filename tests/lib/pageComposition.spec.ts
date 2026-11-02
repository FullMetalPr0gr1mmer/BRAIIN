import { describe, it, expect, vi, beforeEach } from 'vitest';

// getPageComposition's three outcomes. The middle one is the reason it exists in this
// form: a published page that nobody has composed yet must still hand back its row, or
// the SEO role's per-page override (keyed by the page id) silently does nothing until a
// content creator happens to author a section — which is the seeded launch state.

const PAGE = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'home',
  title: { en: 'Home', ar: 'الرئيسية' },
  updated_at: null,
};
let pageRow: unknown = PAGE;
let sectionRows: unknown[] = [];
let sectionError: unknown = null;

vi.mock('@/lib/supabase/client', () => ({
  supabaseConfigured: () => true,
  anonClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order']) q[m] = () => q;
      q['maybeSingle'] = async () => ({ data: pageRow, error: null });
      // awaiting the builder is how the sections list resolves
      q['then'] = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(
          resolve(table === 'page_sections' ? { data: sectionRows, error: sectionError } : {}),
        );
      return q;
    },
  }),
}));

const { getPageComposition, getPageSections } = await import('@/lib/data/pageSections');

beforeEach(() => {
  pageRow = PAGE;
  sectionRows = [];
  sectionError = null;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('getPageComposition', () => {
  it('is null when the page is not published (no row)', async () => {
    pageRow = null;
    expect(await getPageComposition('home')).toBeNull();
  });

  it('returns the page with NO sections when it is published but not composed', async () => {
    const c = await getPageComposition('home');
    expect(c?.page.id).toBe(PAGE.id);
    expect(c?.sections).toEqual([]);
    // …and the sections-only accessor still reads "not composed" as null (use the default)
    expect(await getPageSections('home')).toBeNull();
  });

  it('keeps the page when the sections read fails', async () => {
    sectionError = { code: '42501', message: 'denied' };
    const c = await getPageComposition('home');
    expect(c?.page.id).toBe(PAGE.id);
    expect(c?.sections).toEqual([]);
  });

  it('returns the authored composition, dropping unknown types', async () => {
    sectionRows = [
      { type: 'cta', content: {}, visible: true, sort_order: 1 },
      { type: 'not-a-type', content: {}, visible: true, sort_order: 2 },
    ];
    const c = await getPageComposition('home');
    expect(c?.sections.map((s) => s.type)).toEqual(['cta']);
    expect((await getPageSections('home'))?.length).toBe(1);
  });

  // E10-S1: a Text block row written around the API (a staff token straight to PostgREST)
  // with a node's or a mark's `type` nested 3,500 deep. The section walk once stringified it
  // and threw a RangeError, which emptied the whole composition (null: the route rendered its
  // default and lost the page's SEO override). The row degrades to an empty section instead.
  it('a Text block whose type is nested 3,500 deep degrades to an empty section', async () => {
    const deep = (n: number) => JSON.parse('['.repeat(n) + ']'.repeat(n)) as unknown;
    const words = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }],
    };
    const typeBomb = { type: 'doc', content: [{ type: deep(3500), content: [] }] };
    const markBomb = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'x', marks: [{ type: deep(3500) }] }],
        },
      ],
    };
    sectionRows = [
      {
        type: 'textBlock',
        content: { body: { en: typeBomb, ar: words } },
        visible: true,
        sort_order: 1,
      },
      {
        type: 'textBlock',
        content: { body: { en: words, ar: markBomb } },
        visible: true,
        sort_order: 2,
      },
      { type: 'cta', content: {}, visible: true, sort_order: 3 },
    ];
    const c = await getPageComposition('home');
    expect(c?.page.id).toBe(PAGE.id);
    expect(c?.sections.map((s) => [s.type, s.props])).toEqual([
      ['textBlock', {}],
      ['textBlock', {}],
      ['cta', {}],
    ]);
  });

  // E11 review E11-C2: a section edit never moves pages.updated_at, so a custom page's
  // WebPage dateModified (and its sitemap lastmod) would understate the page's last change.
  // Code review CR6: the date rides on the section it belongs to, so a route dates only what
  // it renders, and a row the loader drops (an unknown type) takes its date with it.
  it('gives each section its own row’s date, and none to a row it drops', async () => {
    pageRow = { ...PAGE, updated_at: '2026-10-01T08:00:00+00:00' };
    sectionRows = [
      {
        type: 'cta',
        content: {},
        visible: true,
        sort_order: 1,
        updated_at: '2026-10-05T08:00:00+00:00',
      },
      {
        type: 'not-a-type',
        content: {},
        visible: true,
        sort_order: 2,
        updated_at: '2026-10-30T12:00:00.123456+00:00',
      },
      { type: 'slogan', content: {}, visible: true, sort_order: 3 },
    ];
    const c = await getPageComposition('home');
    expect(c?.page.updatedAt).toBe('2026-10-01T08:00:00+00:00');
    expect(c?.sections.map((s) => [s.type, s.updatedAt])).toEqual([
      ['cta', '2026-10-05T08:00:00+00:00'],
      ['slogan', undefined],
    ]);
    expect(JSON.stringify(c)).not.toContain('2026-10-30');
  });
});
