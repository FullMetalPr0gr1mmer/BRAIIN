import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import {
  VISIBILITY_PAGE_BATCH,
  listVisibility,
  readVisibilityPages,
} from '@/lib/admin/pageVisibility';
import { redirectChoices } from '@/components/admin/screens/visibility/VisibilityScreen';
import { draftOf } from '@/components/admin/screens/visibility/VisibilityDrawer';
import { PAGE_PATHS } from '@/lib/visibility/routes';

// Which pages the page visibility screen lists, and where a hidden page may send its visitors
// (Admin v2 E11 code review). CR2: the route pages are read apart from the custom pages, and
// the custom pages a batch at a time in a fixed order, so no number of custom pages can cut a
// route page (the homepage first) out of the list. CR1: a custom page takes a hidden page's
// visitors only while it is published; the drawer offers only those, and a stored redirect to
// one unpublished since reads as the 404 the live site now shows.

const AUTH = { tenantId: 't-1', role: 'admin' } as unknown as AuthContext;

type Row = Record<string, unknown>;

/**
 * A PostgREST stand-in over one table of pages that honours what the reader asks: eq, in,
 * `not in`, order, range and limit, and answers in the table's own (insertion) order when no
 * order is asked for, as a heap would. Every read is recorded.
 */
function client(pages: Row[]) {
  const reads: string[][] = [];
  const from = (table: string) => {
    const asked: string[] = [];
    reads.push(asked);
    let rows: Row[] = table === 'pages' ? [...pages] : [];
    const orders: string[] = [];
    let window: [number, number] | null = null;
    let limit: number | null = null;
    const b: Record<string, unknown> = {};
    b['select'] = () => b;
    b['eq'] = (column: string, value: unknown) => {
      asked.push(`eq:${column}`);
      if (column !== 'tenant_id') rows = rows.filter((r) => r[column] === value);
      return b;
    };
    b['in'] = (column: string, values: unknown[]) => {
      asked.push(`in:${column}`);
      rows = rows.filter((r) => values.includes(r[column]));
      return b;
    };
    b['not'] = (column: string, op: string, list: string) => {
      asked.push(`not:${column}:${op}`);
      const values = list.replace(/^\(|\)$/g, '').split(',');
      rows = rows.filter((r) => !values.includes(String(r[column])));
      return b;
    };
    b['order'] = (column: string) => {
      asked.push(`order:${column}`);
      orders.push(column);
      return b;
    };
    b['range'] = (a: number, z: number) => {
      asked.push(`range:${a}-${z}`);
      window = [a, z];
      return b;
    };
    b['limit'] = (n: number) => {
      asked.push(`limit:${n}`);
      limit = n;
      return b;
    };
    b['then'] = (ok: (v: unknown) => unknown) => {
      let out = [...rows];
      for (const column of [...orders].reverse()) {
        out.sort((x, y) => String(x[column]).localeCompare(String(y[column])));
      }
      if (window) out = out.slice(window[0], window[1] + 1);
      if (limit !== null) out = out.slice(0, limit);
      return Promise.resolve(
        table === 'pages' ? { data: out, error: null } : { data: [], error: null, count: 0 },
      ).then(ok);
    };
    return b;
  };
  return { sb: { from } as unknown as SupabaseClient, reads };
}

const page = (slug: string, status = 'published', i = 0): Row => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  slug,
  title: { en: slug },
  status,
});

/** 450 custom pages stored before the seven route pages (the order a heap may answer in). */
function crowded(): Row[] {
  const custom = Array.from({ length: 450 }, (_, i) =>
    page(`page-${String(449 - i).padStart(3, '0')}`, 'published', i + 1),
  );
  const routes = Object.keys(PAGE_PATHS).map((slug, i) => page(slug, 'published', 1000 + i));
  return [...custom, ...routes];
}

describe('the pages page visibility lists (CR2)', () => {
  it('every route page, in the map’s order, however many custom pages come first', async () => {
    const { sb } = client(crowded());
    const rows = await readVisibilityPages(sb, AUTH);
    expect(rows.slice(0, 7).map((r) => r.slug)).toEqual(Object.keys(PAGE_PATHS));
    expect(rows).toHaveLength(457);
    const custom = rows.slice(7).map((r) => r.slug);
    expect(custom).toEqual([...custom].sort());
  });

  it('the custom pages in ordered batches, the route pages in one read of their own', async () => {
    const { sb, reads } = client(crowded());
    await readVisibilityPages(sb, AUTH);
    expect(reads[0]).toEqual(['eq:tenant_id', 'in:slug']);
    const batches = reads.slice(1);
    expect(batches).toHaveLength(Math.ceil(450 / VISIBILITY_PAGE_BATCH));
    for (const [i, asked] of batches.entries()) {
      expect(asked).toEqual([
        'eq:tenant_id',
        'not:slug:in',
        'order:slug',
        'order:id',
        `range:${i * VISIBILITY_PAGE_BATCH}-${(i + 1) * VISIBILITY_PAGE_BATCH - 1}`,
      ]);
    }
  });
});

describe('where a hidden page may send its visitors (CR1)', () => {
  const pages = [
    page('home', 'published', 1),
    page('contact', 'draft', 2),
    page('our-story', 'published', 3),
    page('later', 'draft', 4),
    page('gone', 'archived', 5),
  ];

  it('the list marks the pages that render: a route page always, a custom page if published', async () => {
    const { sb } = client(pages);
    const list = await listVisibility(sb, AUTH);
    expect(Object.fromEntries(list.pages.map((p) => [p.slug, p.redirectable]))).toEqual({
      home: true,
      contact: true,
      gone: false,
      later: false,
      'our-story': true,
    });
    expect(redirectChoices(list.pages).map((c) => c.label)).toEqual([
      'home',
      'contact',
      'our-story',
    ]);
  });

  it('a stored redirect to a page no longer offered reads as the 404 it now gives', () => {
    const offered = [
      { id: 'home-id', label: 'Home' },
      { id: 'story-id', label: 'Our story' },
    ];
    const hidden = (redirectPageId: string | null) =>
      ({
        kind: 'page',
        id: 'about-id',
        slug: 'about',
        title: { en: 'About' },
        path: '/about',
        redirectable: true,
        setting: {
          id: 'row',
          mode: 'hidden',
          redirectPageId,
          hideFrom: null,
          showOn: null,
          note: null,
          passwordVersion: 0,
          version: 1,
          updatedAt: null,
        },
      }) as const;
    expect(draftOf(hidden('story-id'), 'home-id', offered).redirect).toBe('story-id');
    expect(draftOf(hidden('later-id'), 'home-id', offered).redirect).toBe('');
    expect(draftOf(hidden(null), 'home-id', offered).redirect).toBe('');
  });
});
