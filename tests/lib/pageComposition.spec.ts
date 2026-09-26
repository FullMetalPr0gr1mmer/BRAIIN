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
});
