import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  fixedLayers,
  layeredDb,
  liveDb,
  memoDb,
  RELEASE_READ_TOTAL_IDS_MAX,
  RELEASE_SINGLETON_TABLES,
  type LayerChange,
  type TableLayer,
} from '@/lib/release/overlayDb';
import { pendingDb } from '@/lib/release/layers';
import { stagedUpdate } from '@/lib/release/staged';
import { RELEASE_REGISTRY, registryByTable } from '@/lib/release/registry';
import { redirectResource } from '@/lib/admin/resources/redirects';
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
      services: [
        {
          id: '0f0f0f0f-0000-4000-8000-000000000011',
          tenant_id: T,
          slug: 'logo',
          status: 'published',
          version: 1,
        },
      ],
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

describe('a staged save is judged without its own pending change', () => {
  it('editing a pending new redirect to swap its paths is not read as a loop with itself', async () => {
    const own = '0f0f0f0f-0000-4000-8000-000000000031';
    const db = makeDb({
      redirects: [],
      content_drafts: [
        draftRow({
          id: '77777777-7777-4777-8777-000000000031',
          entity_type: 'redirect',
          entity_id: own,
          op: 'create',
          payload: { sourcePath: '/old-a', targetPath: '/old-b' },
          base: {},
          base_version: null,
        }),
      ],
    });
    const sb = client(db) as unknown as SupabaseClient;
    const ctx = { auth, sb, audit: () => undefined } as unknown as Parameters<
      typeof stagedUpdate
    >[2];
    const row = await stagedUpdate(redirectResource, registryByTable('redirects')!, ctx, own, {
      draftId: '77777777-7777-4777-8777-000000000031',
      draftVersion: 1,
      sourcePath: '/old-b',
      targetPath: '/old-a',
    });
    expect(row['source_path']).toBe('/old-b');
    // Another pending rule still counts: the same swap beside a pending /old-a -> /old-b is a loop.
    expect(
      await (async () => {
        db.tables['content_drafts']!.push(
          draftRow({
            id: '77777777-7777-4777-8777-000000000032',
            entity_type: 'redirect',
            entity_id: '0f0f0f0f-0000-4000-8000-000000000032',
            op: 'create',
            payload: { sourcePath: '/old-a', targetPath: '/old-b' },
            base: {},
            base_version: null,
          }),
        );
        const draft = db.tables['content_drafts']!.find(
          (d) => d['id'] === '77777777-7777-4777-8777-000000000031',
        )!;
        return stagedUpdate(redirectResource, registryByTable('redirects')!, ctx, own, {
          draftId: draft['id'],
          draftVersion: draft['version'],
          sourcePath: '/old-b',
          targetPath: '/old-a',
        }).then(
          () => 'saved',
          (err: unknown) => (err instanceof Error ? err.message : String(err)),
        );
      })(),
    ).toMatch(/loop/);
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

describe('many reads in one request (Admin v2 R7, O-16: public.release_read_rows)', () => {
  const uid = (n: number) => `0f0f0f0f-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const setup = (tables: Record<string, Row[]>) => {
    const db = makeDb(tables);
    return { db, live: liveDb(client(db) as unknown as SupabaseClient, auth) };
  };

  it('reads keyed by id or tenant go together, in order, projected, the caller’s tenant only', async () => {
    const { db, live } = setup({
      services: [
        { id: uid(1), tenant_id: T, slug: 'logo', status: 'published' },
        { id: uid(2), tenant_id: OTHER, slug: 'theirs', status: 'published' },
      ],
      media_assets: [{ id: uid(3), tenant_id: T, kind: 'image', alt: null }],
      site_profile: [{ tenant_id: T, brand_name: 'Studio' }],
    });
    const answers = await live.listMany([
      { table: 'services', query: { columns: 'id,slug', in: { id: [uid(1), uid(2)] } } },
      { table: 'media_assets', query: { columns: 'id,kind,alt', in: { id: [uid(3)] } } },
      { table: 'site_profile', query: { columns: 'brand_name', in: { tenant_id: [T] } } },
    ]);
    expect(answers).toEqual([
      [{ id: uid(1), slug: 'logo' }],
      [{ id: uid(3), kind: 'image', alt: null }],
      [{ brand_name: 'Studio' }],
    ]);
    expect(db.calls).toEqual([
      {
        kind: 'rpc',
        name: 'release_read_rows',
        values: {
          p_tenant: T,
          p_reads: [
            { table: 'services', columns: ['id', 'slug'], key: 'id', ids: [uid(1), uid(2)] },
            { table: 'media_assets', columns: ['id', 'kind', 'alt'], key: 'id', ids: [uid(3)] },
            { table: 'site_profile', columns: ['brand_name'], key: 'tenant_id', ids: [T] },
          ],
        },
      },
    ]);
  });

  it('a read it cannot serve exactly (an order, a limit, an eq, another key, a non-uuid) goes as before', async () => {
    const { db, live } = setup({
      services: [{ id: uid(1), tenant_id: T, slug: 'logo', status: 'published' }],
    });
    await live.listMany([
      { table: 'services', query: { columns: 'id', in: { id: [uid(1)] } } },
      { table: 'services', query: { columns: 'id', in: { slug: ['logo'] } } },
      { table: 'services', query: { columns: 'id', in: { id: ['s1'] } } },
      { table: 'services', query: { columns: 'id', eq: { slug: 'logo' } } },
      {
        table: 'services',
        query: { columns: 'id', in: { id: [uid(1)] }, order: { column: 'slug' } },
      },
      { table: 'services', query: { columns: 'id', in: { id: [uid(1)] }, limit: 1 } },
      { table: 'services', query: { columns: 'id:slug', in: { id: [uid(1)] } } },
    ]);
    const rpc = db.calls.filter((c) => c.kind === 'rpc');
    expect(rpc).toHaveLength(1);
    expect((rpc[0]!.values as { p_reads: unknown[] }).p_reads).toEqual([
      { table: 'services', columns: ['id'], key: 'id', ids: [uid(1)] },
    ]);
    expect(db.calls.filter((c) => c.kind === 'from' && c.name === 'services')).toHaveLength(6);
  });

  it('a tenant-keyed read goes in the batch only for a singleton; another table’s as before', async () => {
    const { db, live } = setup({
      site_profile: [{ tenant_id: T, brand_name: 'Studio' }],
      services: [{ id: uid(1), tenant_id: T, slug: 'logo' }],
      media_assets: [{ id: uid(3), tenant_id: T, kind: 'image' }],
    });
    const answers = await live.listMany([
      { table: 'site_profile', query: { columns: 'brand_name', in: { tenant_id: [T] } } },
      { table: 'services', query: { columns: 'id', in: { tenant_id: [T] } } },
      { table: 'media_assets', query: { columns: 'id', in: { tenant_id: [T] } } },
    ]);
    expect(answers).toEqual([[{ brand_name: 'Studio' }], [{ id: uid(1) }], [{ id: uid(3) }]]);
    const rpc = db.calls.filter((c) => c.kind === 'rpc');
    expect(rpc).toHaveLength(1);
    expect(
      (rpc[0]!.values as { p_reads: { table: string }[] }).p_reads.map((r) => r.table),
    ).toEqual(['site_profile']);
    expect(db.calls.filter((c) => c.kind === 'from').map((c) => c.name)).toEqual([
      'services',
      'media_assets',
    ]);
  });

  it('the singletons it reads by tenant are the registry’s (0103 refuses any other)', () => {
    const singletons = Object.values(RELEASE_REGISTRY)
      .filter((entry) => entry.key === 'tenant_id')
      .map((entry) => entry.table)
      .sort();
    expect([...RELEASE_SINGLETON_TABLES].sort()).toEqual(singletons);
  });

  it('more than 2,000 ids in all take more requests, each within the bound, joined in order', async () => {
    const { db, live } = setup({});
    const reads = Array.from({ length: 5 }, (_, r) => ({
      table: 'services',
      query: {
        columns: 'id',
        in: { id: Array.from({ length: 500 }, (_, n) => uid(10_000 + r * 1000 + n)) },
      },
    }));
    db.tables['services'] = [
      { id: uid(10_000), tenant_id: T },
      { id: uid(14_499), tenant_id: T },
    ];
    const answers = await live.listMany(reads);
    expect(answers[0]).toEqual([{ id: uid(10_000) }]);
    expect(answers[4]).toEqual([{ id: uid(14_499) }]);
    const sent = db.calls
      .filter((c) => c.name === 'release_read_rows')
      .map((c) => (c.values as { p_reads: { ids: string[] }[] }).p_reads);
    expect(sent.map((batch) => batch.reduce((sum, r) => sum + r.ids.length, 0))).toEqual([
      2000, 500,
    ]);
    for (const batch of sent) {
      expect(batch.reduce((sum, r) => sum + r.ids.length, 0)).toBeLessThanOrEqual(
        RELEASE_READ_TOTAL_IDS_MAX,
      );
    }
  });

  it('an empty read asks nothing; more than 40 reads or 500 ids take more requests, joined', async () => {
    const { db, live } = setup({});
    expect(
      await live.listMany([{ table: 'services', query: { columns: 'id', in: { id: [] } } }]),
    ).toEqual([[]]);
    expect(db.calls).toEqual([]);

    const many = Array.from({ length: 41 }, (_, n) => ({
      table: 'services',
      query: { columns: 'id', in: { id: [uid(n + 1)] } },
    }));
    await live.listMany(many);
    expect(db.calls.filter((c) => c.name === 'release_read_rows')).toHaveLength(2);

    db.calls.length = 0;
    const ids = Array.from({ length: 501 }, (_, n) => uid(n + 100));
    db.tables['services'] = [
      { id: ids[0], tenant_id: T },
      { id: ids[500], tenant_id: T },
    ];
    const [rows] = await live.listMany([
      { table: 'services', query: { columns: 'id', in: { id: ids } } },
    ]);
    expect(rows).toEqual([{ id: ids[0] }, { id: ids[500] }]);
    const sent = db.calls[0]!.values as { p_reads: { ids: string[] }[] };
    expect(sent.p_reads.map((r) => r.ids.length)).toEqual([500, 1]);
  });

  it('a refused read throws, naming the tables', async () => {
    const { db, live } = setup({});
    db.fail = (call) =>
      call.name === 'release_read_rows' ? { code: '42501', message: 'staff only' } : null;
    await expect(
      live.listMany([{ table: 'services', query: { columns: 'id', in: { id: [uid(1)] } } }]),
    ).rejects.toThrow(/read services/);
  });

  it('over the layers: the live reads of every table in one request, the same answer as list', async () => {
    const { db, live } = setup({
      services: [
        { id: uid(1), tenant_id: T, slug: 'logo', status: 'published' },
        { id: uid(2), tenant_id: T, slug: 'old', status: 'published' },
      ],
      disciplines: [{ id: uid(5), tenant_id: T, status: 'draft' }],
    });
    const layered = layeredDb(
      live,
      fixedLayers(
        new Map([
          [
            'services',
            new Map<string, LayerChange>([
              [uid(2), { op: 'update', patch: { slug: 'new' } }],
              [uid(9), { op: 'create', row: { id: uid(9), tenant_id: T, slug: 'web' } }],
            ]),
          ],
        ]),
      ),
    );
    const reads = [
      { table: 'services', query: { columns: 'id,slug', in: { id: [uid(1), uid(2), uid(9)] } } },
      { table: 'disciplines', query: { columns: 'id,status', in: { id: [uid(5)] } } },
    ];
    const many = await layered.listMany(reads);
    expect(db.calls.map((c) => `${c.kind}:${c.name}`)).toEqual(['rpc:release_read_rows']);
    const one = await Promise.all(reads.map((r) => layered.list(r.table, r.query)));
    expect(many).toEqual(one);
    expect(many[0]).toEqual(
      expect.arrayContaining([
        { id: uid(1), slug: 'logo' },
        { id: uid(2), slug: 'new' },
        { id: uid(9), slug: 'web' },
      ]),
    );
  });

  it('the memo asks each read once, and a later list of the same read costs nothing', async () => {
    const { db, live } = setup({ disciplines: [{ id: uid(5), tenant_id: T }] });
    const memo = memoDb(live);
    const read = { table: 'disciplines', query: { columns: 'id', in: { id: [uid(5)] } } };
    await memo.listMany([read, read]);
    await memo.listMany([read]);
    expect(await memo.list(read.table, read.query)).toEqual([{ id: uid(5) }]);
    expect(db.calls).toHaveLength(1);
  });
});
