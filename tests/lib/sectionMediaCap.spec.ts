import { describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import { MEDIA_BLOCKS_FULL, MEDIA_BLOCKS_PER_PAGE } from '@schemas/sectionTypes';
import { collectionRoutes, itemRoutes } from '@/lib/admin/resource';
import { sectionResource } from '@/lib/admin/resources';
import { ValidationError } from '@/lib/admin/errors';
import type { OverlayDb } from '@/lib/release/overlayDb';
import type { AuthContext } from '@/lib/auth/types';

vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));
vi.mock('@/lib/admin/audit', () => ({ writeAudit: async () => undefined }));

// The media block cap (Admin v2 E10 review, E10-S2): a page holds at most
// MEDIA_BLOCKS_PER_PAGE Galleries and Videos together, hidden ones included. The API refuses
// the next one (sectionResource.assertWritable), counted on the merged or staged view; Add
// section says the same first (tests/lib/pageEditorLibrary.spec.ts).

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAGE = '22222222-2222-4222-8222-222222222222';
const OTHER_PAGE = '22222222-2222-4222-8222-222222222223';
const id = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
const auth = { tenantId: TENANT, userId: id(999), role: 'admin' } as unknown as AuthContext;

/** A page holding `n` media blocks, served by an overlay database (a staged or publish view). */
function pageWith(n: number) {
  const asked: { table: string; query: unknown }[] = [];
  const rows = Array.from({ length: n }, (_, i) => ({
    id: id(i),
    type: i % 2 ? 'video' : 'gallery',
  }));
  const db = {
    list: async (table: string, query: { limit?: number }) => {
      asked.push({ table, query });
      return rows.slice(0, query.limit ?? rows.length);
    },
  } as unknown as OverlayDb;
  return { db, asked };
}

type R = Record<string, unknown>;
/** The rule as a kernel calls it; `before` left out is a caller that does not say (the old way). */
const check = (merged: R, changed: R, db: OverlayDb, before?: R | null) =>
  sectionResource.assertWritable!(merged, {
    auth,
    sb: {} as never,
    changed,
    db,
    ...(before === undefined ? {} : { before }),
  });

describe('a page takes at most eight Galleries and Videos', () => {
  it('a new one joins seven, never eight', async () => {
    for (const type of ['gallery', 'video']) {
      const row = { page_id: PAGE, type, content: {} };
      await expect(
        check(row, row, pageWith(MEDIA_BLOCKS_PER_PAGE - 1).db),
      ).resolves.toBeUndefined();
      const full = check(row, row, pageWith(MEDIA_BLOCKS_PER_PAGE).db);
      await expect(full).rejects.toBeInstanceOf(ValidationError);
      await expect(full).rejects.toMatchObject({ field: 'type', detail: MEDIA_BLOCKS_FULL });
    }
  });

  it('asks for the page’s media blocks only, in one bounded read', async () => {
    const { db, asked } = pageWith(3);
    const row = { page_id: PAGE, type: 'gallery', content: {} };
    await check(row, row, db);
    expect(asked).toEqual([
      {
        table: 'page_sections',
        query: {
          columns: 'id,type',
          eq: { page_id: PAGE },
          in: { type: ['gallery', 'video'] },
          limit: MEDIA_BLOCKS_PER_PAGE + 1,
        },
      },
    ]);
  });

  it('an edit of one of the eight does not count it against itself', async () => {
    const { db } = pageWith(MEDIA_BLOCKS_PER_PAGE);
    const stored = { id: id(3), page_id: PAGE, type: 'video', content: {} };
    await expect(check(stored, { type: 'video' }, db)).resolves.toBeUndefined();
  });

  it('a section that is not a media block, or a save that moves nothing, reads nothing', async () => {
    const { db, asked } = pageWith(20);
    const text = { page_id: PAGE, type: 'textBlock', content: {} };
    await expect(check(text, text, db)).resolves.toBeUndefined();
    const stored = { id: id(3), page_id: PAGE, type: 'gallery', content: {} };
    await expect(check(stored, { content: {} }, db)).resolves.toBeUndefined();
    await expect(check(stored, { visible: true }, db)).resolves.toBeUndefined();
    expect(asked).toEqual([]);
  });

  it('a media block moved to a full page, or a section turned into one there, is refused', async () => {
    const { db } = pageWith(MEDIA_BLOCKS_PER_PAGE);
    const moved = { id: id(100), page_id: PAGE, type: 'gallery', content: {} };
    await expect(check(moved, { page_id: PAGE }, db)).rejects.toBeInstanceOf(ValidationError);
    await expect(check(moved, { type: 'gallery' }, db)).rejects.toBeInstanceOf(ValidationError);
  });

  it('through the API with releases off: the ninth is a 422 with the words, nothing written', async () => {
    const inserted: unknown[] = [];
    const reads: string[] = [];
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'limit']) builder[m] = () => builder;
    builder['in'] = (column: string) => {
      reads.push(column);
      return builder;
    };
    builder['insert'] = (row: unknown) => {
      inserted.push(row);
      return builder;
    };
    builder['single'] = async () => ({ data: { id: id(50), version: 1 }, error: null });
    builder['then'] = (resolve: (value: unknown) => unknown) =>
      Promise.resolve(
        resolve({
          data: Array.from({ length: MEDIA_BLOCKS_PER_PAGE }, (_, i) => ({
            id: id(i),
            type: 'gallery',
          })),
          error: null,
        }),
      );
    const sb = { from: () => builder, rpc: async () => ({ data: false, error: null }) };
    const url = new URL('https://admin.example.test/api/admin/sections');
    const ctx = {
      request: new Request(url, {
        method: 'POST',
        body: JSON.stringify({ pageId: PAGE, type: 'video', content: {} }),
        headers: { 'content-type': 'application/json' },
      }),
      url,
      params: {},
      locals: {
        session: {
          userId: id(999),
          tenantId: TENANT,
          role: 'admin',
          isActive: true,
          email: 'x@example.test',
        },
        supabase: sb,
        cspNonce: 'n',
        csrfToken: 'c',
      },
    } as unknown as Parameters<APIRoute>[0];
    const res = (await collectionRoutes(sectionResource).POST(ctx)) as Response;
    expect(res.status).toBe(422);
    const body = (await res.json()) as { field?: string; detail?: string };
    expect(body).toMatchObject({ field: 'type', detail: MEDIA_BLOCKS_FULL });
    expect(reads).toEqual(['type']);
    expect(inserted).toEqual([]);
  });
});

// E10 code review, CR4: the cap counts a row only when it BECOMES a media block on the page.
// The editor's form sends `type` with every save, so before the fix a block on a page already
// over the cap (rows written around the API, or two saves racing) could not be saved at all.
describe('an edit that changes neither the type nor the page is never refused by the cap', () => {
  /** A page already over the cap, the edited block among its rows. */
  const over = () => pageWith(MEDIA_BLOCKS_PER_PAGE + 2);

  it('a block re-saved with its own type on an over-full page saves, and reads nothing', async () => {
    const { db, asked } = over();
    const stored = { id: id(3), page_id: PAGE, type: 'video', content: {} };
    for (const changed of [{ type: 'video' }, { type: 'video', content: {} }, { page_id: PAGE }]) {
      await expect(check(stored, changed, db, stored)).resolves.toBeUndefined();
    }
    expect(asked).toEqual([]);
  });

  it('a gallery turned into a video on the same page is still one media block', async () => {
    const { db, asked } = over();
    const before = { id: id(2), page_id: PAGE, type: 'gallery', content: {} };
    const merged = { ...before, type: 'video' };
    await expect(check(merged, { type: 'video' }, db, before)).resolves.toBeUndefined();
    expect(asked).toEqual([]);
  });

  it('a row that becomes one there is still counted and refused', async () => {
    const text = { id: id(100), page_id: PAGE, type: 'textBlock', content: {} };
    const turned = { ...text, type: 'gallery' };
    await expect(
      check(turned, { type: 'gallery' }, pageWith(MEDIA_BLOCKS_PER_PAGE).db, text),
    ).rejects.toBeInstanceOf(ValidationError);
    const elsewhere = { id: id(101), page_id: OTHER_PAGE, type: 'video', content: {} };
    const moved = { ...elsewhere, page_id: PAGE };
    await expect(
      check(moved, { page_id: PAGE }, pageWith(MEDIA_BLOCKS_PER_PAGE).db, elsewhere),
    ).rejects.toBeInstanceOf(ValidationError);
    // A create has no row before it.
    const created = { page_id: PAGE, type: 'video', content: {} };
    await expect(
      check(created, created, pageWith(MEDIA_BLOCKS_PER_PAGE).db, null),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('through the API with releases off: a PATCH restating the type of a block there saves', async () => {
    const stored = {
      id: id(3),
      page_id: PAGE,
      type: 'video',
      content: {},
      visible: true,
      is_placeholder: false,
      version: 1,
    };
    const reads: string[] = [];
    const updated: unknown[] = [];
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'limit']) builder[m] = () => builder;
    builder['in'] = (column: string) => {
      reads.push(column);
      return builder;
    };
    builder['update'] = (row: unknown) => {
      updated.push(row);
      return builder;
    };
    builder['maybeSingle'] = async () => ({ data: stored, error: null });
    builder['single'] = async () => ({ data: { ...stored, version: 2 }, error: null });
    builder['then'] = (resolve: (value: unknown) => unknown) =>
      Promise.resolve(
        resolve({
          data: Array.from({ length: MEDIA_BLOCKS_PER_PAGE + 2 }, (_, i) => ({
            id: id(i),
            type: 'video',
          })),
          error: null,
        }),
      );
    const sb = { from: () => builder, rpc: async () => ({ data: false, error: null }) };
    const url = new URL(`https://admin.example.test/api/admin/sections/${id(3)}`);
    const ctx = {
      request: new Request(url, {
        method: 'PATCH',
        body: JSON.stringify({ type: 'video', content: {}, version: 1 }),
        headers: { 'content-type': 'application/json' },
      }),
      url,
      params: { id: id(3) },
      locals: {
        session: {
          userId: id(999),
          tenantId: TENANT,
          role: 'admin',
          isActive: true,
          email: 'x@example.test',
        },
        supabase: sb,
        cspNonce: 'n',
        csrfToken: 'c',
      },
    } as unknown as Parameters<APIRoute>[0];
    const res = (await itemRoutes(sectionResource).PATCH(ctx)) as Response;
    expect(res.status).toBe(200);
    // No count was read for a row that already was a media block on its page.
    expect(reads).toEqual([]);
    expect(updated).toHaveLength(1);
  });
});
