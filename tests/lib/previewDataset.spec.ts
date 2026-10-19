import { describe, expect, it, vi } from 'vitest';
import * as overlay from '@/lib/release/overlay';
import {
  createPreviewSource,
  CREATE_DEFAULTS,
  PREVIEW_MEDIA_ROW_CAP,
  PREVIEW_ROW_CAP,
} from '@/lib/preview/dataset';
import { FOREIGN_KEYS } from '@/lib/preview/relations';
import {
  BI,
  draft,
  fakeStaffClient,
  fixtureTables,
  ID,
  id,
  OTHER_TENANT,
  session,
  TENANT,
  type FakeClientOptions,
} from '../fixtures/previewDataset';

// The preview's dataset (Admin v2 R8, src/lib/preview/dataset.ts) against a fake staff client
// that records every request: range() paging to an exact count under a max_rows cap, the
// per-table cap, lazy and memoised reads, the drafts overlaid per operation (cascades,
// set-null, a project's link sets, R4's stamps), the drafts left out (and why), `only`, and
// rows of another tenant.

vi.mock('@/lib/release/overlay', async (importOriginal) => {
  const actual = await importOriginal<typeof overlay>();
  return { ...actual, derivePatch: vi.fn(actual.derivePatch) };
});

type Row = Record<string, unknown>;
const NOW = new Date('2026-03-01T12:00:00.000Z');

function source(
  tables: Record<string, Row[]>,
  drafts: Row[] = [],
  opts: FakeClientOptions & { only?: string[]; role?: Parameters<typeof session>[0] } = {},
) {
  const fake = fakeStaffClient({ ...tables, content_drafts: drafts }, opts);
  const preview = createPreviewSource({
    supabase: fake.client,
    session: session(opts.role ?? 'admin'),
    now: () => NOW,
    ...(opts.only ? { only: opts.only } : {}),
  });
  const db = preview.client() as unknown as {
    from(t: string): {
      select(
        c: string,
      ): PromiseLike<{ data: Row[] | null; error: { code: string } | null }> &
        Record<string, (...a: unknown[]) => never>;
    };
  };
  return { fake, preview, db, report: preview.report() };
}

async function read(db: ReturnType<typeof source>['db'], table: string, columns: string) {
  const { data, error } = await db.from(table).select(columns);
  if (error) throw new Error(`${table}: ${error.code}`);
  return data!;
}

const many = (n: number, extra: (i: number) => Row = () => ({})) =>
  Array.from({ length: n }, (_, i) => ({
    id: id(10_000 + i),
    tenant_id: TENANT,
    slug: `c${i}`,
    name: BI('C', 'ك'),
    ...extra(i),
  }));

describe('reading live rows', () => {
  it('pages with range() and an exact count, in key order', async () => {
    const { fake, db } = source({ categories: many(2_345 - 345) });
    expect(await read(db, 'categories', 'id')).toHaveLength(2_000);
    expect(fake.calls).toEqual([
      'content_drafts range(0,999)',
      'categories range(0,999)',
      'categories range(1000,1999)',
    ]);
    expect(fake.selects['categories']).toEqual([
      { columns: '*', options: { count: 'exact' } },
      { columns: '*', options: { count: 'exact' } },
    ]);
  });

  it('reads every row when max_rows is below the page size: the count ends paging, not a short page', async () => {
    const { fake, db } = source({ categories: many(1_200) }, [], { maxRows: 500 });
    expect(await read(db, 'categories', 'id')).toHaveLength(1_200);
    expect(fake.calls.filter((c) => c.startsWith('categories'))).toEqual([
      'categories range(0,999)',
      'categories range(500,1499)',
      'categories range(1000,1999)',
    ]);
  });

  it('caps a table and marks it truncated (media has its own cap)', async () => {
    const { db, report } = source({ categories: many(PREVIEW_ROW_CAP + 5) });
    expect(await read(db, 'categories', 'id')).toHaveLength(PREVIEW_ROW_CAP);
    expect(report.truncated).toEqual(['categories']);
    expect(PREVIEW_MEDIA_ROW_CAP).toBe(5_000);
  });

  it("reads the column-granted tables with anon's columns only", async () => {
    const { fake, db } = source(fixtureTables());
    await read(db, 'service_cases', 'id');
    expect(fake.selects['service_cases']![0]!.columns).toBe(
      'id,tenant_id,service_id,portfolio_id,title,context,problems,results,status,published_at,updated_at',
    );
    expect(fake.selects['services']![0]!.columns).toBe('*');
  });

  it('loads lazily: three tables read make three requests plus one for the drafts', async () => {
    const { fake, db } = source(fixtureTables());
    await read(db, 'categories', 'id');
    await read(db, 'certifications', 'id');
    await read(db, 'sectors', 'id');
    await read(db, 'categories', 'slug');
    expect(fake.calls).toEqual([
      'content_drafts range(0,999)',
      'categories range(0,999)',
      'certifications range(0,999)',
      'sectors range(0,999)',
    ]);
  });

  it('loads what a rule reads with the table (services read disciplines)', async () => {
    const { fake, db } = source(fixtureTables());
    await read(db, 'service_cases', 'id');
    expect(fake.calls.map((c) => c.split(' ')[0]).sort()).toEqual([
      'content_drafts',
      'disciplines',
      'service_cases',
      'services',
    ]);
  });

  it('memoises per source and starts fresh for the next', async () => {
    const tables = fixtureTables();
    const first = source(tables);
    await read(first.db, 'sectors', 'id');
    await Promise.all([read(first.db, 'sectors', 'id'), read(first.db, 'sectors', 'slug')]);
    expect(first.fake.calls).toEqual(['content_drafts range(0,999)', 'sectors range(0,999)']);
    const second = source(tables);
    await read(second.db, 'sectors', 'id');
    expect(second.fake.calls).toEqual(['content_drafts range(0,999)', 'sectors range(0,999)']);
  });

  it("answers a table's queries with its read error, and records it", async () => {
    const { db, report } = source(fixtureTables(), [], {
      fail: {
        disciplines: { code: '57014', message: 'canceling statement due to statement timeout' },
      },
    });
    const { data, error } = await db.from('services').select('id');
    expect(data).toBeNull();
    expect(error).toMatchObject({ code: '57014' });
    expect(report.failedTables).toEqual(['disciplines']);
    // Another table still reads.
    expect(await read(db, 'sectors', 'id')).toHaveLength(1);
  });

  it('fails every query when the drafts cannot be read', async () => {
    const { db, report } = source(fixtureTables(), [], {
      fail: { content_drafts: { code: '42501', message: 'permission denied' } },
    });
    const { error } = await db.from('sectors').select('id');
    expect(error).toMatchObject({ code: '42501' });
    expect(report.failedTables).toEqual(['content_drafts']);
  });

  it("drops another tenant's rows and drafts, and counts them", async () => {
    const tables = fixtureTables();
    tables['sectors']!.push({
      id: ID.foreign,
      tenant_id: OTHER_TENANT,
      slug: 'x',
      name: BI('X', 'س'),
      visible: true,
      sort_order: 0,
    });
    const { db, report } = source(tables, [
      draft('sector', 'update', ID.secVis, { slug: 'renamed' }, { tenant_id: OTHER_TENANT }),
    ]);
    const rows = await read(db, 'sectors', 'id,slug');
    expect(rows).toEqual([{ id: ID.secVis, slug: 'retail' }]);
    expect(report.foreignTenantRows).toBe(2);
    expect(report.overlaid).toBe(0);
    expect(report.pending).toBe(0);
  });
});

describe('laying the drafts over', () => {
  it('update: live ⊕ patch, stamped updated_at; a first publish stamps published_at', async () => {
    const { db, report } = source(fixtureTables(), [
      draft('service', 'update', ID.sDraft, { title: BI('Boxes', 'صناديق'), status: 'published' }),
      draft('service', 'update', ID.sPub, { title: BI('Logos', 'شعارات') }),
    ]);
    const rows = await read(db, 'services', 'id,title,updated_at,published_at');
    expect(rows).toContainEqual({
      id: ID.sDraft,
      title: BI('Boxes', 'صناديق'),
      updated_at: NOW.toISOString(),
      published_at: NOW.toISOString(),
    });
    // Already published: published_at is never rewritten (edge case 15).
    expect(rows).toContainEqual({
      id: ID.sPub,
      title: BI('Logos', 'شعارات'),
      updated_at: NOW.toISOString(),
      published_at: '2026-01-01T00:00:00+00:00',
    });
    expect(report.overlaid).toBe(2);
    expect(report.pending).toBe(2);
  });

  it('create: the key, the tenant, the column defaults, then the patch', async () => {
    const { db } = source(fixtureTables(), [
      draft('sector', 'create', id(701), { slug: 'health', name: BI('Health', 'الصحة') }),
      draft('client', 'create', id(702), { slug: 'quiet', name: BI('Quiet', 'هادئ') }),
    ]);
    const sectors = await read(db, 'sectors', 'id,slug,visible,sort_order,updated_at');
    expect(sectors).toContainEqual({
      id: id(701),
      slug: 'health',
      visible: true,
      sort_order: 0,
      updated_at: NOW.toISOString(),
    });
    // A client is hidden by default (0021: `visible` is the disclosure permission).
    expect(CREATE_DEFAULTS.clients).toMatchObject({ visible: false });
    expect((await read(db, 'clients', 'id')).map((r) => r['id'])).not.toContain(id(702));
  });

  it('delete: the row goes, its children cascade, and what pointed at it is cleared', async () => {
    const { db, report } = source(fixtureTables(), [
      draft('portfolio', 'delete', ID.pPub),
      draft('client', 'delete', ID.clVis),
      draft('category', 'delete', ID.cat1),
      draft('team_member', 'delete', ID.tmPub),
    ]);
    expect((await read(db, 'portfolio', 'id')).map((r) => r['id'])).toEqual([ID.pPub2]);
    // cascade (0022): its frames and links go
    expect(await read(db, 'portfolio_media', 'id')).toEqual([]);
    expect(await read(db, 'portfolio_services', 'portfolio_id')).toEqual([]);
    // set null (0021, 0022, 0028, 0001): the testimonial's project and client, the case's
    // project, the post's category and author
    expect(await read(db, 'testimonials', 'id,portfolio_id,client_id')).toEqual([
      { id: ID.tPub, portfolio_id: null, client_id: null },
    ]);
    expect(await read(db, 'service_cases', 'id,portfolio_id')).toEqual([
      { id: ID.cPub, portfolio_id: null },
    ]);
    expect(await read(db, 'blog_posts', 'slug,category_id,author_id')).toContainEqual({
      slug: 'new',
      category_id: null,
      author_id: null,
    });
    // Counted as each table is read: the clients, categories and team are not read yet.
    expect(report.overlaid).toBe(1);
    await Promise.all(['clients', 'categories', 'team_members'].map((t) => read(db, t, 'id')));
    expect(report.overlaid).toBe(4);
  });

  it("replaces a project's link sets as app.apply_portfolio_children does (position from 0)", async () => {
    const { db } = source(fixtureTables(), [
      draft('portfolio', 'update', ID.pPub, {
        serviceIds: [ID.sNoDisc, ID.sPub],
        media: [
          { role: 'hero', kind: 'image', mediaId: ID.mFrame },
          { role: 'gallery', kind: 'image', mediaId: ID.mPoster, caption: BI('Two', 'اثنان') },
        ],
      }),
    ]);
    const links = await read(db, 'portfolio_services', 'portfolio_id,service_id,sort_order');
    expect(links).toEqual([
      { portfolio_id: ID.pPub, service_id: ID.sNoDisc, sort_order: 0 },
      { portfolio_id: ID.pPub, service_id: ID.sPub, sort_order: 1 },
    ]);
    const frames = await read(db, 'portfolio_media', 'role,media_id,caption,sort_order');
    expect(frames).toEqual([
      { role: 'hero', media_id: ID.mFrame, caption: null, sort_order: 0 },
      { role: 'gallery', media_id: ID.mPoster, caption: BI('Two', 'اثنان'), sort_order: 1 },
    ]);
  });

  it('keys the singletons on their tenant', async () => {
    const { db } = source(fixtureTables(), [
      draft('site_profile', 'update', TENANT, { brandName: BI('New name', 'اسم') }),
      draft('seo_defaults', 'update', TENANT, { robotsDirectives: 'noindex' }),
    ]);
    expect(await read(db, 'site_profile', 'brand_name')).toEqual([
      { brand_name: BI('New name', 'اسم') },
    ]);
    expect(await read(db, 'seo_defaults', 'robots_directives')).toEqual([
      { robots_directives: 'noindex' },
    ]);
  });
});

describe('review fixes', () => {
  it("an update never moves a row's key or tenant, whatever its patch holds", async () => {
    vi.mocked(overlay.derivePatch).mockImplementationOnce(() => ({
      patch: { slug: 'moved', id: id(990), tenant_id: OTHER_TENANT },
      children: {},
      exempt: {},
    }));
    const { db, report } = source(fixtureTables(), [
      draft('sector', 'update', ID.secVis, { slug: 'moved' }),
    ]);
    expect(await read(db, 'sectors', 'id,tenant_id,slug')).toEqual([
      { id: ID.secVis, tenant_id: TENANT, slug: 'moved' },
    ]);
    expect(report.overlaid).toBe(1);
  });

  it('a delete of a row that is already gone is reported, not counted as shown', async () => {
    const { db, report } = source(fixtureTables(), [draft('sector', 'delete', id(991))]);
    expect(await read(db, 'sectors', 'id')).toEqual([{ id: ID.secVis }]);
    expect(report.overlaid).toBe(0);
    expect(report.invalid).toEqual([
      expect.objectContaining({ entityId: id(991), reason: 'live-missing' }),
    ]);
  });
});

describe("a project's link sets follow only a change that was shown", () => {
  it('an invalid create over a live project leaves its links as they are', async () => {
    const { db, report } = source(fixtureTables(), [
      draft('portfolio', 'create', ID.pPub, {
        slug: 'again',
        title: BI('Again', 'مجددا'),
        serviceIds: [ID.sNoDisc],
        media: [{ role: 'hero', kind: 'image', mediaId: ID.mPoster }],
      }),
    ]);
    // Links read first: the project is read with them, whatever the order.
    expect(await read(db, 'portfolio_services', 'portfolio_id,service_id')).toEqual([
      { portfolio_id: ID.pPub, service_id: ID.sPub },
      { portfolio_id: ID.pPub, service_id: ID.sDraft },
    ]);
    expect(await read(db, 'portfolio_media', 'id')).toEqual([{ id: ID.pmPub }]);
    expect(report.invalid).toEqual([
      expect.objectContaining({ entityId: ID.pPub, reason: 'invalid' }),
    ]);
  });

  it("a links-only change keeps the project's updated_at (R4 runs no UPDATE for it)", async () => {
    const { db, report } = source(fixtureTables(), [
      draft('portfolio', 'update', ID.pPub, { serviceIds: [ID.sNoDisc] }),
    ]);
    expect(await read(db, 'portfolio', 'id,updated_at')).toContainEqual({
      id: ID.pPub,
      updated_at: '2026-01-01T00:00:00+00:00',
    });
    expect(await read(db, 'portfolio_services', 'portfolio_id,service_id')).toEqual([
      { portfolio_id: ID.pPub, service_id: ID.sNoDisc },
    ]);
    expect(report.overlaid).toBe(1);
  });

  it('an edit of a project that is gone sets no links', async () => {
    const { db, report } = source(fixtureTables(), [
      draft('portfolio', 'update', id(992), { serviceIds: [ID.sPub] }),
    ]);
    await read(db, 'portfolio_services', 'portfolio_id');
    expect(report.invalid).toEqual([
      expect.objectContaining({ entityId: id(992), reason: 'live-missing' }),
    ]);
    const links = await read(db, 'portfolio_services', 'portfolio_id');
    expect(links.map((r) => r['portfolio_id'])).not.toContain(id(992));
  });
});

describe('stamps, as one release applies them', () => {
  it('a set-null bumps the child row as the database trigger does', async () => {
    const { db } = source(fixtureTables(), [draft('team_member', 'delete', ID.tmPub)]);
    expect(await read(db, 'blog_posts', 'slug,author_id,updated_at')).toContainEqual({
      slug: 'new',
      author_id: null,
      updated_at: NOW.toISOString(),
    });
    // A row the delete does not touch keeps its own.
    expect(await read(db, 'blog_posts', 'slug,updated_at')).toContainEqual({
      slug: 'old',
      updated_at: null,
    });
  });

  it('every stamp of one preview is one instant (posts published together tie)', async () => {
    let tick = 0;
    const preview = createPreviewSource({
      supabase: fakeStaffClient({
        ...fixtureTables(),
        content_drafts: [
          draft('blog_post', 'update', ID.bDraft, { status: 'published' }),
          draft('blog_post', 'create', id(993), {
            slug: 'np',
            title: BI('P', 'م'),
            status: 'published',
          }),
        ],
      }).client,
      session: session('admin'),
      now: () => new Date(Date.UTC(2030, 0, 1) + 1000 * tick++),
    });
    const { data } = await preview.client().from('blog_posts').select('id,published_at,updated_at');
    const rows = (data as unknown as Row[]).filter(
      (r) => r['id'] === ID.bDraft || r['id'] === id(993),
    );
    expect(new Set(rows.flatMap((r) => [r['published_at'], r['updated_at']]))).toEqual(
      new Set(['2030-01-01T00:00:00.000Z']),
    );
  });
});

describe("a quote's consent (0028 testimonials_consent_gate)", () => {
  it('a change that would publish a quote without recorded consent is reported, not shown', async () => {
    const { db, report } = source(fixtureTables(), [
      draft('testimonial', 'update', ID.tDraft, { status: 'published' }),
      draft('testimonial', 'create', id(994), {
        slug: 'new-quote',
        quote: BI('Q', 'ق'),
        authorName: BI('N', 'ن'),
        status: 'published',
      }),
    ]);
    const shown = (await read(db, 'testimonials', 'id')).map((r) => r['id']);
    expect(shown).not.toContain(ID.tDraft);
    expect(shown).not.toContain(id(994));
    expect(report.invalid.map((i) => [i.entityId, i.reason]).sort()).toEqual(
      [
        [ID.tDraft, 'invalid'],
        [id(994), 'invalid'],
      ].sort(),
    );
  });

  it('with consent recorded in the change, or already on the row, it is shown', async () => {
    const tables = fixtureTables();
    tables['testimonials']!.find((t) => t['id'] === ID.tDraft)!['consent_obtained_at'] =
      '2026-01-01T00:00:00+00:00';
    const { db, report } = source(tables, [
      draft('testimonial', 'update', ID.tDraft, { status: 'published' }),
    ]);
    expect((await read(db, 'testimonials', 'id')).map((r) => r['id'])).toContain(ID.tDraft);
    expect(report.invalid).toEqual([]);
  });

  it('reads the consent columns for itself, never for a loader (still 42501)', async () => {
    const { fake, db } = source(fixtureTables());
    const { error } = await db.from('testimonials').select('id,consent_obtained_at');
    expect(error).toMatchObject({ code: '42501' });
    expect(fake.selects['testimonials']![0]!.columns).toMatch(
      /,consent_obtained_at,is_placeholder$/,
    );
  });
});

describe('a design sample going live (0025 production guard, R9)', () => {
  it('a change that leaves a flagged sample published is shown and counted', async () => {
    const tables = fixtureTables();
    tables['testimonials']!.find((t) => t['id'] === ID.tDraft)!['is_placeholder'] = true;
    const { db, report } = source(tables, [
      draft('testimonial', 'update', ID.tDraft, { status: 'published' }),
    ]);
    expect((await read(db, 'testimonials', 'id')).map((r) => r['id'])).toContain(ID.tDraft);
    expect(report.samples).toBe(1);
    expect(report.invalid).toEqual([]);
  });

  it('a change to a real row, or one that keeps a sample off the site, counts nothing', async () => {
    const tables = fixtureTables();
    tables['testimonials']!.find((t) => t['id'] === ID.tDraft)!['is_placeholder'] = true;
    tables['testimonials']!.find((t) => t['id'] === ID.tDraft)!['consent_obtained_at'] =
      '2026-01-01T00:00:00+00:00';
    const { db, report } = source(tables, [
      draft('testimonial', 'update', ID.tDraft, { status: 'draft' }),
    ]);
    await read(db, 'testimonials', 'id');
    expect(report.samples).toBe(0);
  });
});

describe('the foreign keys a pending delete follows', () => {
  it("cascades only into tables no other key references (a parent's own drafts are the whole set)", () => {
    const cascaded = new Set(
      FOREIGN_KEYS.filter((fk) => fk.onDelete === 'cascade').map((fk) => fk.table),
    );
    const referenced = FOREIGN_KEYS.filter(
      (fk) => fk.onDelete !== 'restrict' && cascaded.has(fk.target) && fk.target !== fk.table,
    );
    expect(referenced).toEqual([]);
    expect([...cascaded].sort()).toEqual(
      [
        'navigation',
        'page_sections',
        'portfolio_media',
        'portfolio_services',
        'service_cases',
      ].sort(),
    );
  });
});

describe('drafts left out', () => {
  it('reports an invalid payload, an edit of a missing row and an SEO target change, and shows none', async () => {
    const { db, report } = source(fixtureTables(), [
      draft('sector', 'update', ID.secVis, { slug: 'NOT A SLUG' }),
      draft('sector', 'update', id(777), { slug: 'ghost' }),
      draft('entity_seo', 'update', ID.esSvc, {
        entityType: 'service',
        entityId: ID.sNoDisc,
        metaTitle: BI('T', 'ع'),
        metaDescription: BI('D', 'و'),
      }),
      draft('service', 'update', ID.sPub, { status: 'scheduled' }),
    ]);
    expect(await read(db, 'sectors', 'slug')).toEqual([{ slug: 'retail' }]);
    expect(
      (await read(db, 'entity_seo', 'id,meta_title')).find((r) => r['id'] === ID.esSvc),
    ).toMatchObject({
      meta_title: BI(`Title ${ID.esSvc.slice(-3)}`, 'عنوان'),
    });
    await read(db, 'services', 'id');
    expect(report.invalid.map((i) => [i.entityId, i.reason]).sort()).toEqual(
      [
        [ID.secVis, 'invalid'],
        [id(777), 'live-missing'],
        [ID.esSvc, 'target-changed'],
        // a per-item schedule is the staged rules' ValidationError
        [ID.sPub, 'invalid'],
      ].sort(),
    );
    expect(report.overlaid).toBe(0);
    expect(report.pending).toBe(4);
  });

  it('reports drift when a draft writes a column the registry does not allow', async () => {
    vi.mocked(overlay.derivePatch).mockImplementationOnce(() => {
      throw new overlay.RegistryDriftError('sector', ['colour']);
    });
    const { db, report } = source(fixtureTables(), [
      draft('sector', 'update', ID.secVis, { slug: 'x' }),
    ]);
    await read(db, 'sectors', 'id');
    expect(report.invalid).toEqual([
      expect.objectContaining({ entityType: 'sector', entityId: ID.secVis, reason: 'drift' }),
    ]);
  });

  it('parses a draft lazily: only when its table is read, and once', async () => {
    vi.mocked(overlay.derivePatch).mockClear();
    const { db } = source(fixtureTables(), [
      draft('sector', 'update', ID.secVis, { slug: 'x' }),
      draft('service', 'update', ID.sPub, { title: BI('X', 'س') }),
    ]);
    await read(db, 'sectors', 'id');
    await read(db, 'sectors', 'slug');
    expect(overlay.derivePatch).toHaveBeenCalledTimes(1);
  });

  it('reports a malformed draft row as invalid', async () => {
    const { db, report } = source(fixtureTables(), [
      draft('sector', 'update', 'not-a-uuid', { slug: 'x' }),
    ]);
    await read(db, 'sectors', 'id');
    expect(report.invalid).toEqual([
      expect.objectContaining({ entityType: 'sector', entityId: 'not-a-uuid', reason: 'invalid' }),
    ]);
  });

  it('previews only the listed drafts with `only`', async () => {
    const keep = draft('sector', 'update', ID.secVis, { slug: 'kept' });
    const skip = draft('certification', 'update', ID.cePub, { slug: 'skipped' });
    const { db, report } = source(fixtureTables(), [keep, skip], { only: [String(keep['id'])] });
    expect(await read(db, 'sectors', 'slug')).toEqual([{ slug: 'kept' }]);
    expect(await read(db, 'certifications', 'slug')).toEqual([{ slug: 'iso' }]);
    expect(report.pending).toBe(1);
  });

  it('reports redirects, themes and page visibility as not previewed', async () => {
    const { db, report } = source(fixtureTables(), [
      draft('redirect', 'create', id(711), { sourcePath: '/a', targetPath: '/b', status: 301 }),
      draft('custom_theme', 'update', id(712), { name: 'Dark' }),
      draft('page_visibility', 'update', id(713), { mode: 'hidden' }),
    ]);
    await read(db, 'pages', 'id');
    expect(report.notPreviewed.sort()).toEqual(['custom_theme', 'page_visibility', 'redirect']);
    expect(report.pending).toBe(3);
    expect(report.invalid).toEqual([]);
  });

  it('counts, never lists, drafts in areas the role may not read (edge case 16: Developer)', async () => {
    const { db, report } = source(
      fixtureTables(),
      [
        draft('page', 'update', ID.pgDraft, { status: 'published' }),
        draft('service', 'update', ID.sDraft, { status: 'published' }),
        draft('service', 'update', id(778), { slug: 'NOT A SLUG' }),
      ],
      { role: 'developer' },
    );
    expect((await read(db, 'pages', 'id')).map((r) => r['id']).sort()).toEqual(
      [ID.pgHome, ID.pgDraft, ID.pgLocked].sort(),
    );
    expect((await read(db, 'services', 'id')).map((r) => r['id'])).not.toContain(ID.sDraft);
    expect(report.draftsNotShown).toBe(2);
    expect(report.pending).toBe(1);
    expect(report.invalid).toEqual([]);
  });
});
