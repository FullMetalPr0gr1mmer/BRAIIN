import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MEDIA_BLOCKS_PER_PAGE } from '@schemas/sectionTypes';
import { GALLERY_MAX_ITEMS } from '@schemas/sections';
import { withPageAccess } from '@/lib/visibility/scope';

// How a page behind a password gets its own images back (Admin v2 U14b).
//
// anon reads a media row only while something public names it, and the page_sections branch
// of that policy runs under anon's RLS, which the password fence (0061) now covers: a still
// only the locked page names answers nothing to the anon read, for a visitor who typed the
// password too. Inside `withPageAccess` the loader reads the ids through
// `public.page_media_unlocked` as the service role instead, for the page that request
// unlocked and with the tenant the middleware carried from the snapshot.

const TENANT = '11111111-1111-4111-8111-111111111111';
const PAGE_ID = '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const MEDIA_ID = '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

const ROW = {
  id: MEDIA_ID,
  kind: 'image',
  provider: 'static',
  storage_path: 'stills/work/p2.jpg',
  width: 1280,
  height: 720,
  alt: { en: 'The studio', ar: 'الاستوديو' },
  stream_uid: null,
};

/** Every query the loader made, in order, with the client it used. */
const calls: { via: 'anon' | 'service'; what: string; args?: unknown }[] = [];

vi.mock('@/lib/data/source', () => ({
  contentClient: () => ({
    from: (table: string) => {
      calls.push({ via: 'anon', what: table });
      const chain = {
        select: () => chain,
        // The fence: anon reads nothing a locked page alone names.
        in: async () => ({ data: [], error: null }),
      };
      return chain;
    },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({
    rpc: async (fn: string, args: unknown) => {
      calls.push({ via: 'service', what: fn, args });
      return { data: [ROW], error: null };
    },
  }),
}));
vi.mock('@/lib/supabase/client', () => ({ supabaseConfigured: () => true }));
vi.mock('@/lib/media/resolve', () => ({
  imageRef: (row: { id: string; storage_path: string }) => ({ src: row.storage_path }),
}));

const { SECTION_MEDIA_MAX_IDS, getSectionImages } = await import('@/lib/data/sectionMedia');
const getSectionImage = async (id: string) => (await getSectionImages([id])).get(id) ?? null;

beforeEach(() => {
  calls.length = 0;
});

describe("the images of a page behind a password's sections", () => {
  it('outside the scope: the anon read, which the fence answers empty', async () => {
    expect(await getSectionImage(MEDIA_ID)).toBeNull();
    expect(calls.map((c) => c.via)).toEqual(['anon']);
  });

  it('inside the scope: the unlocked media reader, named with its tenant and page', async () => {
    const image = await withPageAccess({ pageId: PAGE_ID, tenantId: TENANT }, () =>
      getSectionImage(MEDIA_ID),
    );
    expect(image).toEqual({ src: 'stills/work/p2.jpg' });
    expect(calls).toEqual([
      {
        via: 'service',
        what: 'page_media_unlocked',
        args: { p_tenant: TENANT, p_page_id: PAGE_ID, p_ids: [MEDIA_ID] },
      },
    ]);
  });

  it('asks only for well-formed ids, each once, and at most a page’s worth', async () => {
    // A page's worth (Admin v2 E10 review): every section's media in one read, eight media
    // blocks of twelve pictures, About's poster and Our Work's two frames at most.
    expect(SECTION_MEDIA_MAX_IDS).toBeGreaterThanOrEqual(
      MEDIA_BLOCKS_PER_PAGE * GALLERY_MAX_ITEMS + 3,
    );
    const many = Array.from(
      { length: SECTION_MEDIA_MAX_IDS + 2 },
      (_, i) => `6a1b2c3d-4e5f-4a6b-8c7d-${String(i).padStart(12, '0')}`,
    );
    await withPageAccess({ pageId: PAGE_ID, tenantId: TENANT }, () =>
      getSectionImages(['not-an-id', MEDIA_ID, MEDIA_ID, ...many]),
    );
    expect(calls).toHaveLength(1);
    const args = calls[0]?.args as { p_ids: string[] };
    expect(args.p_ids).toHaveLength(SECTION_MEDIA_MAX_IDS);
    expect(args.p_ids[0]).toBe(MEDIA_ID);
    expect(args.p_ids).not.toContain('not-an-id');
  });

  it('with no tenant to name, it does not reach past the seam at all', async () => {
    await withPageAccess({ pageId: PAGE_ID, tenantId: '' }, () => getSectionImage(MEDIA_ID));
    expect(calls.map((c) => c.via)).toEqual(['anon']);
  });

  it('with no id worth asking for, it asks nothing', async () => {
    await withPageAccess({ pageId: PAGE_ID, tenantId: TENANT }, () =>
      getSectionImages(['not-an-id']),
    );
    expect(calls).toEqual([]);
  });
});
