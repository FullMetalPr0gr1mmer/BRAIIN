import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it, vi } from 'vitest';
import { contentClient, withContentSource } from '@/lib/data/source';
import { compareValues, orderRows } from '@/lib/preview/client';
import { createPreviewSource } from '@/lib/preview/dataset';
import { PreviewUnsupportedError } from '@/lib/preview/select';
import {
  BI,
  fakeStaffClient,
  fixtureTables,
  ID,
  id,
  session,
  TENANT,
} from '../fixtures/previewDataset';

// The preview's PostgREST emulator (Admin v2 R8, src/lib/preview/client.ts), driven through
// a dataset over the fixture tenant: the operations the loaders use behave as PostgREST does
// for a visitor, and every other one is recorded in the report before it throws.

type Row = Record<string, unknown>;

function preview(tables: Record<string, Row[]> = fixtureTables()) {
  const source = createPreviewSource({
    supabase: fakeStaffClient(tables).client,
    session: session('admin'),
  });
  // The loaders' own view of it: the supabase-js types, loosened for the edge cases below.
  const db = source.client() as unknown as {
    from(table: string): any;
    rpc(name: string, args?: unknown): Promise<{ data: unknown; error: { code: string } | null }>;
    [key: string]: unknown;
  };
  return { db, report: source.report() };
}

/** A table of rows for one test, each in the fixture tenant. */
const rowsOf = (...rows: Row[]) => rows.map((r) => ({ tenant_id: TENANT, ...r }));

describe('filters', () => {
  it('eq compares as text: strings, booleans and numbers', async () => {
    const { db } = preview();
    const slug = await db.from('services').select('id').eq('slug', 'logo');
    expect(slug.data).toEqual([{ id: ID.sPub }]);
    const flag = await db.from('portfolio').select('id').eq('is_featured', true);
    expect(flag.data).toEqual([{ id: ID.pPub2 }]);
    const n = await db.from('certifications').select('slug').eq('year', 2025);
    expect(n.data).toEqual([{ slug: 'iso' }]);
    const asText = await db.from('certifications').select('slug').eq('year', '2025');
    expect(asText.data).toEqual([{ slug: 'iso' }]);
  });

  it('a NULL matches no eq', async () => {
    const { db } = preview({
      services: rowsOf(
        { id: id(1), slug: 'a', status: 'published', discipline_id: null, category: null },
        { id: id(2), slug: 'b', status: 'published', discipline_id: null, category: 'null' },
      ),
      disciplines: [],
    });
    const { data } = await db.from('services').select('slug').eq('category', 'null');
    expect(data).toEqual([{ slug: 'b' }]);
  });

  it('in matches any listed value', async () => {
    const { db } = preview();
    const { data } = await db
      .from('media_assets')
      .select('id')
      .in('id', [ID.mPoster, ID.mUnref, ID.mLogo]);
    // mUnref exists but no visible content references it: the mirror hides it.
    expect(data).toEqual([{ id: ID.mPoster }, { id: ID.mLogo }]);
  });

  it('contains needs every value in the array column', async () => {
    const { db } = preview();
    const home = await db.from('statistics').select('slug').contains('placements', ['home']);
    expect(home.data).toEqual([{ slug: 'projects' }]);
    const both = await db
      .from('statistics')
      .select('slug')
      .contains('placements', ['home', 'about']);
    expect(both.data).toEqual([{ slug: 'projects' }]);
    const none = await db.from('statistics').select('slug').contains('placements', ['contact']);
    expect(none.data).toEqual([]);
  });

  it('accepts a filter after order and limit (the loaders build the query, then filter)', async () => {
    const { db } = preview();
    let query = db.from('portfolio').select('slug').eq('status', 'published').order('sort_order');
    query = query.limit(5);
    query = query.eq('is_featured', true);
    const { data } = await query;
    expect(data).toEqual([{ slug: 'film' }]);
  });
});

describe('order and limit', () => {
  it('sorts ascending by default and descending on request', async () => {
    const { db } = preview();
    const asc = await db.from('services').select('slug').order('sort_order', { ascending: true });
    expect(asc.data).toEqual([{ slug: 'logo' }, { slug: 'hosting' }]);
    const desc = await db.from('services').select('slug').order('sort_order', { ascending: false });
    expect(desc.data).toEqual([{ slug: 'hosting' }, { slug: 'logo' }]);
  });

  it('places NULLs as PostgREST does, and as nullsFirst says', async () => {
    const { db } = preview();
    // blog: published_at desc, nullsFirst false (the loader's order); the timestamps are
    // compared as instants, whatever their offset.
    const blog = await db
      .from('blog_posts')
      .select('slug')
      .order('published_at', { ascending: false, nullsFirst: false });
    expect(blog.data).toEqual([{ slug: 'new' }, { slug: 'old' }, { slug: 'undated' }]);
    const descDefault = await db
      .from('blog_posts')
      .select('slug')
      .order('published_at', { ascending: false });
    expect(descDefault.data).toEqual([{ slug: 'undated' }, { slug: 'new' }, { slug: 'old' }]);
    const ascDefault = await db.from('blog_posts').select('slug').order('published_at');
    expect(ascDefault.data).toEqual([{ slug: 'old' }, { slug: 'new' }, { slug: 'undated' }]);
    const ascFirst = await db
      .from('blog_posts')
      .select('slug')
      .order('published_at', { nullsFirst: true });
    expect(ascFirst.data).toEqual([{ slug: 'undated' }, { slug: 'old' }, { slug: 'new' }]);
  });

  it('compares timestamps as instants, booleans and numbers natively', () => {
    expect(compareValues('2026-01-01T00:00:00+03:00', '2025-12-31T22:00:00Z')).toBeLessThan(0);
    expect(compareValues('2026-01-01 00:00:00+00', '2026-01-01T00:00:01Z')).toBeLessThan(0);
    expect(compareValues(false, true)).toBeLessThan(0);
    expect(compareValues(10, 9)).toBeGreaterThan(0);
    expect(compareValues('b', 'a')).toBeGreaterThan(0);
  });

  it('sorts by several keys, stably (ties keep the dataset order)', () => {
    const rows = [
      { k: 'a', s: 2, n: 1 },
      { k: 'b', s: 1, n: 2 },
      { k: 'c', s: 2, n: 3 },
      { k: 'd', s: 1, n: 4 },
    ];
    expect(
      orderRows(rows, [{ column: 's', ascending: true, nullsFirst: false }]).map((r) => r.k),
    ).toEqual(['b', 'd', 'a', 'c']);
    expect(
      orderRows(rows, [
        { column: 's', ascending: true, nullsFirst: false },
        { column: 'n', ascending: false, nullsFirst: true },
      ]).map((r) => r.k),
    ).toEqual(['d', 'b', 'c', 'a']);
  });

  it('limits after ordering', async () => {
    const { db } = preview();
    const { data } = await db
      .from('services')
      .select('slug')
      .order('sort_order', { ascending: false })
      .limit(1);
    expect(data).toEqual([{ slug: 'hosting' }]);
  });
});

describe('maybeSingle', () => {
  it('answers null for no row, the row for one, PGRST116 for more', async () => {
    const { db, report } = preview();
    const none = await db.from('services').select('slug').eq('slug', 'nope').maybeSingle();
    expect(none).toMatchObject({ data: null, error: null });
    const one = await db.from('services').select('slug').eq('slug', 'logo').maybeSingle();
    expect(one).toMatchObject({ data: { slug: 'logo' }, error: null });
    const many = await db.from('services').select('slug').maybeSingle();
    expect(many).toMatchObject({ data: null, error: { code: 'PGRST116' } });
    // A failed read is not a read.
    expect(report.reads).toBe(2);
  });
});

describe('columns', () => {
  it('answers 42703 for a column the table does not have', async () => {
    const { db } = preview();
    const { data, error } = await db.from('services').select('id,colour');
    expect(data).toBeNull();
    expect(error).toMatchObject({ code: '42703' });
    const filtered = await db.from('services').select('id').eq('colour', 'red');
    expect(filtered.error).toMatchObject({ code: '42703' });
    const ordered = await db.from('services').select('id').order('colour');
    expect(ordered.error).toMatchObject({ code: '42703' });
  });

  it("answers 42501 for a column outside anon's grant on a column-granted table", async () => {
    const { db } = preview();
    for (const [table, column] of [
      ['testimonials', 'consent_obtained_at'],
      ['media_assets', 'display_name'],
      ['disciplines', 'scheduled_for'],
      ['service_cases', 'is_placeholder'],
    ]) {
      const { error } = await db.from(table!).select(`id,${column}`);
      expect(error, table).toMatchObject({ code: '42501' });
    }
    // Through an embed too.
    const embedded = await db.from('services').select('id,poster:poster_media_id(id,display_name)');
    expect(embedded.error).toMatchObject({ code: '42501' });
  });
});

describe('embeds', () => {
  it('embeds a hidden row as null (the case study\'s "Confidential client")', async () => {
    const { db } = preview();
    const { data } = await db
      .from('portfolio')
      .select('slug,client_id,client:client_id(slug),sector:sector_id(slug)')
      .eq('slug', 'launch')
      .maybeSingle();
    expect(data).toEqual({
      slug: 'launch',
      client_id: ID.clHidden,
      client: null,
      sector: { slug: 'retail' },
    });
  });

  it('drops hidden rows from a one-to-many array and embeds a hidden service as null', async () => {
    const { db } = preview();
    const { data } = await db
      .from('portfolio')
      .select('slug,services:portfolio_services(sort_order,service:service_id(slug))')
      .order('sort_order');
    expect(data).toEqual([
      { slug: 'film', services: [] },
      {
        slug: 'launch',
        services: [
          { sort_order: 0, service: { slug: 'logo' } },
          { sort_order: 1, service: null },
        ],
      },
    ]);
  });

  it('embeds three tables deep (service case → project → poster, client)', async () => {
    const { db } = preview();
    const { data } = await db
      .from('service_cases')
      .select(
        'id,project:portfolio_id(slug,client:client_id(slug),poster:poster_media_id(id,provider))',
      )
      .maybeSingle();
    expect(data).toEqual({
      id: ID.cPub,
      project: { slug: 'launch', client: null, poster: { id: ID.mPoster, provider: 'static' } },
    });
  });

  it('embeds through a table name, and returns only the embedded columns', async () => {
    const { db } = preview();
    const { data } = await db
      .from('blog_posts')
      .select('slug,author:team_members(slug,name),category:categories(slug)')
      .order('slug');
    expect(data).toEqual([
      {
        slug: 'new',
        author: { slug: 'nora', name: BI('Nora', 'نورة') },
        category: { slug: 'craft' },
      },
      // The author is a draft team member: hidden, so null.
      { slug: 'old', author: null, category: { slug: 'craft' } },
      { slug: 'undated', author: { slug: 'nora', name: BI('Nora', 'نورة') }, category: null },
    ]);
  });

  it('refuses an embed it cannot resolve, and records it', async () => {
    const { db, report } = preview();
    expect(() => db.from('services').select('id,clients(slug)')).toThrow(PreviewUnsupportedError);
    expect(report.unsupported).toContain('services: embed clients');
  });
});

describe('what the emulator refuses', () => {
  it('answers rpc with PV001 and records it as not previewed (search), not refused', async () => {
    const { db, report } = preview();
    const result = await db.rpc('search_content', { query: 'x', locale: 'en' });
    expect(result).toMatchObject({ data: null, error: { code: 'PV001' } });
    expect(report.notPreviewed).toEqual(['rpc:search_content']);
    expect(report.unsupported).toEqual([]);
  });

  it.each([
    ['neq', (b: any) => b.neq('slug', 'x')],
    ['range', (b: any) => b.range(0, 1)],
    ['single', (b: any) => b.single()],
    ['is', (b: any) => b.is('discipline_id', null)],
    ['or', (b: any) => b.or('slug.eq.x')],
    ['ilike', (b: any) => b.ilike('slug', '%x%')],
    ['insert', (b: any) => b.insert({})],
  ])('records, then throws on, %s', (name, call) => {
    const { db, report } = preview();
    const builder = name === 'insert' ? db.from('services') : db.from('services').select('id');
    expect(() => call(builder)).toThrow(PreviewUnsupportedError);
    expect(report.unsupported).toEqual([`services.${name}`]);
  });

  it('records, then throws on, the client surface it does not emulate', () => {
    for (const prop of ['schema', 'channel', 'storage', 'functions', 'auth']) {
      const { db, report } = preview();
      expect(() => db[prop]).toThrow(PreviewUnsupportedError);
      expect(report.unsupported).toEqual([`client.${prop}`]);
    }
  });

  it('refuses an unknown table, a dotted filter, options it does not read, and select *', async () => {
    const cases: [string, (db: ReturnType<typeof preview>['db']) => unknown][] = [
      ['from leads', (db) => db.from('leads')],
      [
        'services.eq on an embedded or unnamed column',
        (db) => db.from('services').select('id').eq('discipline.slug', 'x'),
      ],
      [
        'services.order options',
        (db) => db.from('services').select('id').order('sort_order', { referencedTable: 'x' }),
      ],
      [
        'services.limit options',
        (db) => db.from('services').select('id').limit(1, { foreignTable: 'x' }),
      ],
      ['services.select options', (db) => db.from('services').select('id', { count: 'exact' })],
      ['services select: *', (db) => db.from('services').select('*')],
      ['services.select *', (db) => db.from('services').select()],
      ['services.eq before select', (db) => db.from('services').eq('slug', 'x')],
      [
        'services.eq with a non-scalar value',
        (db) => db.from('services').select('id').eq('slug', null),
      ],
      [
        'services.contains with a non-array',
        (db) => db.from('services').select('id').contains('slug', 'x'),
      ],
    ];
    for (const [what, run] of cases) {
      const { db, report } = preview();
      expect(() => run(db), what).toThrow(PreviewUnsupportedError);
      expect(report.unsupported, what).toEqual([what]);
    }
  });

  it('records a contains on a column that is not an array, then rejects', async () => {
    const { db, report } = preview();
    await expect(db.from('services').select('id').contains('slug', ['x'])).rejects.toThrow(
      PreviewUnsupportedError,
    );
    expect(report.unsupported).toEqual(['contains on a non-array column']);
  });

  it('is no thenable itself, and inspecting it records nothing', () => {
    const { db, report } = preview();
    expect((db as Record<string, unknown>)['then']).toBeUndefined();
    expect(String(Object.prototype.toString.call(db))).toBe('[object Object]');
    expect(report.unsupported).toEqual([]);
  });
});

describe('the scope', () => {
  it("never reads the AsyncLocalStorage store inside a builder's then()", async () => {
    const source = createPreviewSource({
      supabase: fakeStaffClient(fixtureTables()).client,
      session: session('admin'),
    });
    await withContentSource(source, async () => {
      const builder = contentClient().from('services').select('slug').eq('slug', 'logo');
      const spy = vi.spyOn(AsyncLocalStorage.prototype, 'getStore');
      try {
        const { data } = await builder;
        expect(data).toEqual([{ slug: 'logo' }]);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
    expect(source.report().reads).toBe(1);
    expect(source.report().tables).toEqual({ services: 1 });
  });
});
