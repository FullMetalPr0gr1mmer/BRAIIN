import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  fixedLayers,
  layeredDb,
  liveDb,
  memoDb,
  type LayerChange,
  type TableLayer,
} from '@/lib/release/overlayDb';
import { pendingDb } from '@/lib/release/layers';
import { assertLinkInTenant } from '@/lib/admin/resources/shared';
import { liveRouteRefusal } from '@/lib/admin/redirectRules';
import { client, T, type Row } from '../fixtures/stagedDb';
import { ADMIN, draftRow, makeDb } from '../fixtures/stagedRoute';

// The overlay-aware database (Admin v2 R6). Releases off, the rules must send exactly the queries
// they sent before R6 (so every save behaves as on main): the recorder below pins them call by
// call. Then the layered view a staged save and a publish judge their rules over.

const auth = {
  tenantId: T,
  userId: ADMIN,
  role: 'admin',
  isActive: true,
  email: 'a@x.test',
} as const;

/** A builder that records every call in order and answers `answer`. */
function recorder(answer: unknown = null) {
  const calls: string[] = [];
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'order', 'limit']) {
    builder[m] = (...args: unknown[]) => {
      calls.push(`${m}(${args.map((a) => JSON.stringify(a)).join(',')})`);
      return builder;
    };
  }
  builder['maybeSingle'] = async () => {
    calls.push('maybeSingle()');
    return { data: answer, error: null };
  };
  builder['then'] = (resolve: (v: unknown) => unknown) => {
    calls.push('await');
    return Promise.resolve(resolve({ data: answer ? [answer] : [], error: null }));
  };
  const sb = {
    from: (t: string) => {
      calls.push(`from(${t})`);
      return builder;
    },
  } as unknown as SupabaseClient;
  return { sb, calls };
}

describe('releases off: the rules send the queries they always sent', () => {
  it('assertLinkInTenant: select id, tenant, id, kind, maybeSingle', async () => {
    const { sb, calls } = recorder({ id: 'x' });
    await assertLinkInTenant(
      { auth, sb, changed: { poster_media_id: 'm1' } },
      { column: 'poster_media_id', table: 'media_assets', field: 'f', message: 'm', image: true },
    );
    expect(calls).toEqual([
      'from(media_assets)',
      'select("id")',
      `eq("tenant_id","${T}")`,
      'eq("id","m1")',
      'eq("kind","image")',
      'maybeSingle()',
    ]);
  });

  it('assertLinkInTenant without the image rule asks no kind; a missing row is refused', async () => {
    const { sb, calls } = recorder(null);
    await expect(
      assertLinkInTenant(
        { auth, sb, changed: { discipline_id: 'd1' } },
        { column: 'discipline_id', table: 'disciplines', field: 'disciplineId', message: 'gone' },
      ),
    ).rejects.toMatchObject({ detail: 'gone', field: 'disciplineId' });
    expect(calls).toEqual([
      'from(disciplines)',
      'select("id")',
      `eq("tenant_id","${T}")`,
      'eq("id","d1")',
      'maybeSingle()',
    ]);
  });

  it('liveRouteRefusal: select id, tenant, slug, status in, limit 1, maybeSingle', async () => {
    const { sb, calls } = recorder(null);
    expect(await liveRouteRefusal('/ar/services/logo', sb, auth)).toBeNull();
    expect(calls).toEqual([
      'from(services)',
      'select("id")',
      `eq("tenant_id","${T}")`,
      'eq("slug","logo")',
      'in("status",["published","scheduled"])',
      'limit(1)',
      'maybeSingle()',
    ]);
  });

  it('the redirect chain read: select, tenant, order, limit, awaited', async () => {
    const { sb, calls } = recorder(null);
    await liveDb(sb, auth).list('redirects', {
      columns: 'id,source_path,target_path',
      order: { column: 'source_path', ascending: true },
      limit: 1000,
    });
    expect(calls).toEqual([
      'from(redirects)',
      'select("id,source_path,target_path")',
      `eq("tenant_id","${T}")`,
      'order("source_path",{"ascending":true})',
      'limit(1000)',
      'await',
    ]);
  });
});

describe('the layered view', () => {
  const live = (tables: Record<string, Row[]>) => {
    const db = makeDb(tables);
    return { db, live: liveDb(client(db) as unknown as SupabaseClient, auth) };
  };
  const layer = (entries: [string, LayerChange][]): TableLayer => new Map(entries);

  it('a removed row is gone, a new row is there, an edit is read by its new values', async () => {
    const { live: base } = live({
      services: [
        { id: 's1', tenant_id: T, slug: 'logo', status: 'published' },
        { id: 's2', tenant_id: T, slug: 'motion', status: 'published' },
        { id: 's3', tenant_id: T, slug: 'old', status: 'published' },
      ],
    });
    const db = layeredDb(
      base,
      fixedLayers(
        new Map([
          [
            'services',
            layer([
              ['s1', { op: 'delete' }],
              ['s3', { op: 'update', patch: { slug: 'new' } }],
              [
                's9',
                { op: 'create', row: { id: 's9', tenant_id: T, slug: 'web', status: 'draft' } },
              ],
            ]),
          ],
        ]),
      ),
    );
    expect(await db.exists('services', 's1')).toBe(false);
    expect(await db.exists('services', 's2')).toBe(true);
    expect(await db.exists('services', 's9')).toBe(true);
    expect(await db.first('services', { columns: 'id', eq: { slug: 'old' } })).toBeNull();
    expect(await db.first('services', { columns: 'id', eq: { slug: 'new' } })).toEqual({
      id: 's3',
    });
    const all = await db.list('services', {
      columns: 'id,slug',
      order: { column: 'slug', ascending: true },
    });
    expect(all).toEqual([
      { id: 's2', slug: 'motion' },
      { id: 's3', slug: 'new' },
      { id: 's9', slug: 'web' },
    ]);
    expect(await db.list('services', { columns: 'id', in: { status: ['published'] } })).toEqual([
      { id: 's2' },
      { id: 's3' },
    ]);
  });

  it('an edit that moves a row into a filter is found; out of it, it is not', async () => {
    const { live: base } = live({
      services: [
        { id: 's1', tenant_id: T, slug: 'logo', status: 'draft' },
        { id: 's2', tenant_id: T, slug: 'web', status: 'published' },
      ],
    });
    const db = layeredDb(
      base,
      fixedLayers(
        new Map([
          [
            'services',
            layer([
              ['s1', { op: 'update', patch: { status: 'published' } }],
              ['s2', { op: 'update', patch: { status: 'archived' } }],
            ]),
          ],
        ]),
      ),
    );
    expect(await db.list('services', { columns: 'id', eq: { status: 'published' } })).toEqual([
      { id: 's1' },
    ]);
  });

  it('exists with a condition judges an edit on its new values', async () => {
    const { live: base } = live({
      media_assets: [{ id: 'm1', tenant_id: T, kind: 'video' }],
    });
    const db = layeredDb(
      base,
      fixedLayers(
        new Map([['media_assets', layer([['m1', { op: 'update', patch: { kind: 'image' } }]])]]),
      ),
    );
    expect(await db.exists('media_assets', 'm1', { kind: 'image' })).toBe(true);
  });

  it('another tenant’s row is never there', async () => {
    const { live: base } = live({ clients: [{ id: 'c1', tenant_id: 'other' }] });
    const db = layeredDb(base, fixedLayers(new Map()));
    expect(await db.exists('clients', 'c1')).toBe(false);
  });
});

describe('the pending view of a staged save', () => {
  it('a link to a pending new item passes; a live link costs no draft read', async () => {
    const db = makeDb({
      disciplines: [{ id: 'd1', tenant_id: T }],
      content_drafts: [
        draftRow({
          entity_type: 'discipline',
          entity_id: '0f0f0f0f-0000-4000-8000-000000000002',
          op: 'create',
          payload: { slug: 'film', name: { en: 'Film', ar: 'فيلم' }, status: 'draft' },
          base: {},
          base_version: null,
        }),
      ],
    });
    const sb = client(db) as unknown as SupabaseClient;
    const pending = pendingDb(sb, auth);
    expect(await pending.exists('disciplines', 'd1')).toBe(true);
    expect(db.calls.filter((c) => c.name === 'content_drafts')).toEqual([]);
    expect(await pending.exists('disciplines', '0f0f0f0f-0000-4000-8000-000000000002')).toBe(true);
    expect(await pending.exists('disciplines', 'nope')).toBe(false);
    // The type's drafts are read once per request.
    expect(db.calls.filter((c) => c.name === 'content_drafts')).toHaveLength(1);
  });

  it('a pending rename frees the old slug for a redirect', async () => {
    const db = makeDb({
      services: [{ id: '0f0f0f0f-0000-4000-8000-000000000011', tenant_id: T, slug: 'logo', status: 'published', version: 1 }],
      content_drafts: [
        draftRow({
          entity_type: 'service',
          entity_id: '0f0f0f0f-0000-4000-8000-000000000011',
          op: 'update',
          payload: { slug: 'logo-design' },
          base: { slug: 'logo' },
        }),
      ],
    });
    const sb = client(db) as unknown as SupabaseClient;
    expect(await liveRouteRefusal('/services/logo', sb, auth)).not.toBeNull();
    expect(await liveRouteRefusal('/services/logo', sb, auth, pendingDb(sb, auth))).toBeNull();
  });
});

describe('the memo', () => {
  it('asks each question once, and answers a primed one without asking', async () => {
    const db = makeDb({ disciplines: [{ id: 'd1', tenant_id: T }] });
    const memo = memoDb(liveDb(client(db) as unknown as SupabaseClient, auth));
    await memo.exists('disciplines', 'd1');
    await memo.exists('disciplines', 'd1');
    memo.primeExists('disciplines', 'd2', {}, true);
    expect(await memo.exists('disciplines', 'd2')).toBe(true);
    memo.primeFirst('media_assets', { columns: 'alt', eq: { id: 'm' } }, { alt: null });
    expect(await memo.first('media_assets', { columns: 'alt', eq: { id: 'm' } })).toEqual({
      alt: null,
    });
    expect(db.calls).toHaveLength(1);
  });
});
