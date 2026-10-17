import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withPageAccess } from '@/lib/visibility/scope';

// How a page behind a password gets its own words back (Admin v2 U14b).
//
// The anon client reads none of a locked page's sections: the RLS fence (0061) answers an
// empty list, by design, so the edge gate failing open leaks nothing. A request that typed
// the password runs inside `withPageAccess`, and only then does the loader read them
// through `public.page_sections_unlocked` as the service role — for that one page, with the
// tenant the middleware carried from the snapshot.

const TENANT = '11111111-1111-4111-8111-111111111111';
const PAGE_ID = '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

const SECTIONS = [{ type: 'slogan', content: {}, visible: true, sort_order: 10 }];

/** Every query the loader made, in order, with the client it used. */
const calls: { via: 'anon' | 'service'; what: string; args?: unknown }[] = [];

const builder = (rows: unknown[]) => {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    maybeSingle: async () => ({
      data: { id: PAGE_ID, slug: 'about', title: { en: 'About', ar: 'عن' }, updated_at: null },
      error: null,
    }),
    then: (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null }),
  };
  return chain;
};

vi.mock('@/lib/data/source', () => ({
  contentClient: () => ({
    from: (table: string) => {
      calls.push({ via: 'anon', what: table });
      // The fence: anon reads no section of a locked page.
      return builder(table === 'page_sections' ? [] : []);
    },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({
    rpc: async (fn: string, args: unknown) => {
      calls.push({ via: 'service', what: fn, args });
      return { data: SECTIONS, error: null };
    },
  }),
}));
vi.mock('@/lib/supabase/client', () => ({ supabaseConfigured: () => true }));

const { getPageComposition } = await import('@/lib/data/pageSections');

beforeEach(() => {
  calls.length = 0;
});

describe('the sections of a page behind a password', () => {
  it('outside the scope: the anon read, which the fence answers empty', async () => {
    const composition = await getPageComposition('about');
    expect(composition?.sections).toEqual([]);
    expect(calls.map((c) => c.via)).toEqual(['anon', 'anon']);
  });

  it('inside the scope, for that page: the unlocked reader, named with its tenant', async () => {
    const composition = await withPageAccess({ pageId: PAGE_ID, tenantId: TENANT }, () =>
      getPageComposition('about'),
    );
    expect(composition?.sections).toEqual([{ type: 'slogan', visible: true, props: {} }]);
    expect(calls).toEqual([
      { via: 'anon', what: 'pages' },
      {
        via: 'service',
        what: 'page_sections_unlocked',
        args: { p_tenant: TENANT, p_page_id: PAGE_ID },
      },
    ]);
  });

  it('inside the scope, for ANOTHER page: the anon read, as for any visitor', async () => {
    const other = '9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d';
    await withPageAccess({ pageId: other, tenantId: TENANT }, () => getPageComposition('about'));
    expect(calls.map((c) => c.via)).toEqual(['anon', 'anon']);
  });

  it('with no tenant to name, it does not reach past the seam at all', async () => {
    await withPageAccess({ pageId: PAGE_ID, tenantId: '' }, () => getPageComposition('about'));
    expect(calls.map((c) => c.via)).toEqual(['anon', 'anon']);
  });
});
