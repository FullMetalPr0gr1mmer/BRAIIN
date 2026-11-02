import { beforeEach, describe, expect, it, vi } from 'vitest';

// getPublishedCustomPages (Admin v2 E11), the sitemap's and llms.txt's reader, against a
// stubbed client. E11 review E11-C2: its `updatedAt` is the sitemap's <lastmod>, and a section
// edit never moves pages.updated_at, so it is the later of the row's and its newest section's
// (embedded), as the page's own WebPage dateModified is. Code review CR6: only a section the
// page renders (the custom set) dates it; CR7: the bound counts custom pages only, in a fixed
// order.

const db = vi.hoisted(() => ({
  rows: [] as unknown[],
  calls: [] as [string, unknown[]][],
  limit: null as number | null,
}));
vi.mock('@/lib/supabase/client', () => ({
  supabaseConfigured: () => true,
  anonClient: () => ({
    from: (table: string) => {
      db.calls.push(['from', [table]]);
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'limit']) {
        q[m] = (...args: unknown[]) => {
          db.calls.push([m, args]);
          if (m === 'limit') db.limit = args[0] as number;
          return q;
        };
      }
      // The rows as the database orders them (the spec's own order), cut at the limit.
      q['then'] = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(
          resolve({ data: db.rows.slice(0, db.limit ?? db.rows.length), error: null }),
        );
      return q;
    },
  }),
}));

const { getPublishedCustomPages } = await import('@/lib/data/customPages');

const row = (
  slug: string,
  updated: string | null,
  sections?: (string | null | [string, string | null])[],
) => ({
  id: `00000000-0000-4000-8000-${String(slug.length).padStart(12, '0')}`,
  slug,
  title: { en: slug, ar: slug },
  updated_at: updated,
  ...(sections
    ? {
        page_sections: sections.map((s) =>
          Array.isArray(s)
            ? { type: s[0], updated_at: s[1] }
            : { type: 'textBlock', updated_at: s },
        ),
      }
    : {}),
});

beforeEach(() => {
  db.rows = [];
  db.calls = [];
  db.limit = null;
});

describe('the published custom pages', () => {
  it('embed their sections’ dates (a plain embed, which the releases preview answers)', async () => {
    await getPublishedCustomPages();
    const select = db.calls.find(([m]) => m === 'select')?.[1][0];
    expect(select).toMatch(/page_sections\(type,updated_at\)/);
  });

  it('are dated by the sections the page renders only (CR6)', async () => {
    db.rows = [
      row('our-story', '2026-10-01T08:00:00+00:00', [
        ['hero', '2026-10-05T08:00:00+00:00'],
        // A form written onto the page around the API: never rendered there.
        ['contact', '2026-10-30T12:00:00+00:00'],
      ]),
    ];
    const [page] = await getPublishedCustomPages();
    expect(page?.updatedAt).toBe('2026-10-05T08:00:00+00:00');
  });

  it('list 200 custom pages by address, the route pages never taking their places (CR7)', async () => {
    const custom = Array.from({ length: 205 }, (_, i) => `page-${String(i).padStart(3, '0')}`);
    // As the database orders them by slug: the route pages fall among the custom ones.
    db.rows = [
      ...custom,
      'about',
      'contact',
      'home',
      'join',
      'portfolio',
      'portfolio-all',
      'services',
    ]
      .sort()
      .map((slug) => row(slug, null));
    const pages = await getPublishedCustomPages();
    expect(pages).toHaveLength(200);
    expect(pages.map((p) => p.slug)).toEqual(custom.slice(0, 200));
    expect(db.calls.filter(([m]) => m === 'order').map(([, a]) => a[0])).toEqual(['slug', 'id']);
  });

  it('are dated by the later of the row and its newest section', async () => {
    db.rows = [
      row('our-story', '2026-10-01T08:00:00+00:00', [
        '2026-10-05T08:00:00+00:00',
        '2026-10-30T12:00:00+00:00',
      ]),
      row('how-we-work', '2026-10-20T08:00:00+00:00', ['2026-10-02T08:00:00+00:00']),
      row('no-sections', '2026-10-03T08:00:00+00:00', []),
      row('undated', null, [null]),
      row('section-only', null, ['2026-10-04T08:00:00+00:00']),
      // A route page is never listed here, whatever its dates.
      row('about', '2026-10-31T08:00:00+00:00', ['2026-10-31T09:00:00+00:00']),
    ];
    const pages = await getPublishedCustomPages();
    expect(Object.fromEntries(pages.map((p) => [p.slug, p.updatedAt]))).toEqual({
      'our-story': '2026-10-30T12:00:00+00:00',
      'how-we-work': '2026-10-20T08:00:00+00:00',
      'no-sections': '2026-10-03T08:00:00+00:00',
      undated: null,
      'section-only': '2026-10-04T08:00:00+00:00',
    });
  });
});
