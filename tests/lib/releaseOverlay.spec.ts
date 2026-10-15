import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { ValidationError } from '@/lib/admin/errors';
import { canonical, jsonEqual } from '@/lib/release/deepEqual';
import {
  RegistryDriftError,
  conflicts,
  derivePatch,
  dropNoOps,
  matchesQuery,
  mergePayload,
  overlayList,
  overlayRow,
  recordBase,
  type DraftInput,
} from '@/lib/release/overlay';
import { RELEASE_REGISTRY, type RegistryEntry } from '@/lib/release/registry';

// The overlay core (Admin v2 R2): how a pending change is merged, turned into the columns
// a release writes, and laid over live rows for the admin's lists and forms. Pure
// functions, driven here with plain rows; R3, R6 and R8 call them behind the flag.

const USER = '11111111-1111-4111-8111-111111111111';
const ID = (n: number) => `0f0f0f0f-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BI = (en: string, ar: string) => ({ en, ar });
const DOC = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

let seq = 100;
function draft(
  entityType: string,
  op: 'create' | 'update' | 'delete',
  entityId: string,
  payload: Record<string, unknown>,
  extra: Partial<DraftInput> = {},
): DraftInput {
  seq += 1;
  return {
    id: ID(seq),
    entity_type: entityType as DraftInput['entity_type'],
    entity_id: entityId,
    op,
    payload,
    base: {},
    version: 1,
    created_at: '2026-06-01T08:00:00.000Z',
    updated_at: '2026-06-01T08:00:00.000Z',
    updated_by: USER,
    release_id: null,
    ...extra,
  };
}

const service = RELEASE_REGISTRY.service;
const portfolio = RELEASE_REGISTRY.portfolio;
const siteProfile = RELEASE_REGISTRY.site_profile;
const entitySeo = RELEASE_REGISTRY.entity_seo;

describe('mergePayload', () => {
  it('a shallow merge: undefined skipped, null kept, child sets replaced whole', () => {
    const prev = { title: BI('Old', 'قديم'), slug: 'a', serviceIds: [ID(1), ID(2)] };
    const next = { slug: undefined, title: null, serviceIds: [ID(3)] };
    expect(mergePayload(prev, next, portfolio)).toEqual({
      slug: 'a',
      title: null,
      serviceIds: [ID(3)],
    });
  });

  it('never stores the lock fields or a key the entity does not know', () => {
    const merged = mergePayload(
      null,
      { slug: 'a', version: 3, draftVersion: 2, tenantId: ID(9), published_at: 'x' },
      service,
    );
    expect(merged).toEqual({ slug: 'a' });
  });

  it('never stores the job-application switch (it stays immediate)', () => {
    const merged = mergePayload(
      { brandName: BI('A', 'أ') },
      { acceptingApplications: true, brandName: BI('B', 'ب') },
      siteProfile,
    );
    expect(merged).toEqual({ brandName: BI('B', 'ب') });
  });
});

describe('derivePatch', () => {
  it('a resource create: the create schema with its defaults, then toRow', () => {
    const { patch, children, exempt } = derivePatch(service, 'create', {
      slug: 'brand-film',
      title: BI('Brand film', 'فيلم'),
    });
    expect(patch).toEqual({
      slug: 'brand-film',
      title: BI('Brand film', 'فيلم'),
      status: 'draft',
      is_teaser: false,
      sort_order: 0,
      value_points: [],
      deliverables: [],
    });
    expect(children).toEqual({});
    expect(exempt).toEqual({});
  });

  it('a resource update reads the payload as a PATCH, derived columns included', () => {
    const { patch } = derivePatch(service, 'update', {
      body: { en: DOC('Hello'), ar: DOC('مرحبا') },
      clip: { path: '/media/reel.mp4', startS: 1, endS: 3 },
    });
    expect(Object.keys(patch).sort()).toEqual(
      ['body', 'body_html', 'preview_end_s', 'preview_start_s', 'preview_video_path'].sort(),
    );
  });

  it('never carries published_at: the apply stamps a first publish', () => {
    const { patch } = derivePatch(service, 'update', { status: 'published' });
    expect(patch).toEqual({ status: 'published' });
  });

  it('refuses a per-item schedule: a release is what gets scheduled', () => {
    expect(() =>
      derivePatch(service, 'update', { scheduledFor: '2027-01-01T09:00:00.000Z' }),
    ).toThrow(ValidationError);
    expect(() => derivePatch(service, 'update', { status: 'scheduled' })).toThrow(
      'Schedule the release instead',
    );
    expect(() =>
      derivePatch(service, 'create', { slug: 'x', title: BI('X', 'س'), status: 'scheduled' }),
    ).toThrow(ValidationError);
    // Clearing it is no schedule, and the column is never a release's.
    expect(derivePatch(service, 'update', { scheduledFor: null }).patch).toEqual({});
  });

  it('refuses what the schema refuses, as a save does', () => {
    expect(() => derivePatch(service, 'update', { slug: 'Not A Slug' })).toThrow(ZodError);
    expect(() => derivePatch(service, 'create', { slug: 'only-a-slug' })).toThrow(ZodError);
  });

  it('a delete has no patch', () => {
    expect(derivePatch(service, 'delete', { slug: 'ignored' })).toEqual({
      patch: {},
      children: {},
      exempt: {},
    });
  });

  it('a portfolio change keeps its child sets in the payload’s shape', () => {
    const media = [{ role: 'gallery', kind: 'image', mediaId: ID(4) }];
    const { patch, children } = derivePatch(portfolio, 'update', {
      serviceIds: [ID(1), ID(2)],
      media,
      isFeatured: true,
    });
    expect(patch).toEqual({ is_featured: true });
    expect(children).toEqual({ serviceIds: [ID(1), ID(2)], media });
  });

  it('a singleton: the intake switch moves to exempt; a create starts from the defaults', () => {
    const update = derivePatch(siteProfile, 'update', {
      brandName: BI('Studio', 'استوديو'),
      acceptingApplications: true,
    });
    expect(update.patch).toEqual({ brand_name: BI('Studio', 'استوديو') });
    expect(update.exempt).toEqual({ accepting_applications: true });

    const create = derivePatch(siteProfile, 'create', { brandName: BI('Studio', 'استوديو') });
    expect(create.patch['brand_name']).toEqual(BI('Studio', 'استوديو'));
    expect(Object.keys(create.patch).sort()).toEqual([...siteProfile.columns].sort());
    expect(create.patch).not.toHaveProperty('accepting_applications');
  });

  it('entity SEO: the target is written on create only', () => {
    const payload = {
      entityType: 'service',
      entityId: ID(5),
      metaTitle: BI('T', 'ع'),
      metaDescription: BI('D', 'و'),
    };
    const create = derivePatch(entitySeo, 'create', payload);
    expect(create.patch).toMatchObject({ entity_type: 'service', entity_id: ID(5) });
    expect(create.patch).toMatchObject({ og_image: null, robots: null });
    const update = derivePatch(entitySeo, 'update', payload);
    expect(update.patch).not.toHaveProperty('entity_type');
    expect(update.patch).not.toHaveProperty('entity_id');
    expect(Object.keys(update.patch)).toHaveLength(6);
  });

  it('a column outside the allowlist is registry drift, loudly', () => {
    const drifted: RegistryEntry = { ...RELEASE_REGISTRY.category, columns: ['slug'] };
    expect(() => derivePatch(drifted, 'update', { name: BI('N', 'ن') })).toThrow(
      RegistryDriftError,
    );
    expect(() => derivePatch(drifted, 'update', { slug: 'ok' })).not.toThrow();
  });
});

describe('no-ops, base and conflicts', () => {
  it('a column equal to live is dropped; nothing left is null', () => {
    const live = { slug: 'a', title: BI('A', 'أ'), sort_order: 2 };
    expect(dropNoOps({ slug: 'a', sort_order: 3 }, live)).toEqual({ sort_order: 3 });
    expect(dropNoOps({ slug: 'a', title: { ar: 'أ', en: 'A' } }, live)).toBeNull();
  });

  it('equality is on JSON values: key order, null and instants', () => {
    expect(jsonEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonEqual(undefined, null)).toBe(true);
    expect(jsonEqual('2026-01-02T03:04:05+00:00', '2026-01-02T03:04:05.000Z')).toBe(true);
    expect(jsonEqual('2026-01-02', '2026-01-02T00:00:00.000Z')).toBe(false);
    expect(canonical({ b: undefined, a: null })).toEqual({ a: null });
  });

  it('the base records the live value of each newly patched column, never overwriting', () => {
    const live = { slug: 'a', title: BI('A', 'أ') };
    const first = recordBase(null, live, { slug: 'b' });
    expect(first).toEqual({ slug: 'a' });
    const second = recordBase(first, { slug: 'z', title: BI('Z', 'ز') }, { slug: 'c', title: 1 });
    expect(second).toEqual({ slug: 'a', title: BI('Z', 'ز') });
    expect(recordBase(null, null, { slug: 'b' })).toEqual({ slug: null });
  });

  it('a conflict is a patched column whose live value moved off its base', () => {
    const base = { title: BI('A', 'أ'), value_points: [{ a: 1 }], slug: 'a' };
    const live = { title: BI('A', 'أ'), value_points: [{ a: 2 }], slug: 'a', sort_order: 9 };
    const patch = { title: BI('B', 'ب'), value_points: [], sort_order: 1 };
    expect(conflicts(base, live, patch)).toEqual(['value_points']);
    expect(conflicts(null, live, patch)).toEqual([]);
  });
});

describe('overlayRow', () => {
  const live = {
    id: ID(1),
    slug: 'brand-film',
    title: BI('Brand film', 'فيلم'),
    status: 'published',
    preview_video_path: null,
    preview_start_s: null,
    preview_end_s: null,
    version: 4,
  };

  it('an update is live with the patch over it, shaped by fromRow', () => {
    const d = draft('service', 'update', ID(1), {
      title: BI('New', 'جديد'),
      clip: { path: '/media/reel.mp4', startS: 1, endS: 3 },
    });
    const { row, draft: info } = overlayRow(live, d, service);
    expect(row).toMatchObject({
      id: ID(1),
      title: BI('New', 'جديد'),
      version: 4,
      preview: { path: '/media/reel.mp4', startS: 1, endS: 3 },
    });
    expect(info).toMatchObject({ id: d.id, op: 'update', version: 1, updatedBy: USER });
    expect(info.fields.sort()).toEqual(
      ['preview_end_s', 'preview_start_s', 'preview_video_path', 'title'].sort(),
    );
    expect(info.conflict).toBeUndefined();
  });

  it('reports the columns live moved under', () => {
    const d = draft(
      'service',
      'update',
      ID(1),
      { title: BI('New', 'جديد') },
      {
        base: { title: BI('Older', 'أقدم') },
      },
    );
    expect(overlayRow(live, d, service).draft.conflict).toEqual(['title']);
  });

  it('a create is its patch with its key and version 0; a portfolio’s children ride along', () => {
    const d = draft('portfolio', 'create', ID(7), {
      slug: 'new-case',
      title: BI('New case', 'جديد'),
      serviceIds: [ID(1)],
    });
    const { row } = overlayRow(null, d, portfolio);
    expect(row).toMatchObject({
      id: ID(7),
      version: 0,
      slug: 'new-case',
      status: 'draft',
      service_ids: [ID(1)],
    });
  });

  it('a singleton create is keyed by the tenant', () => {
    const tenant = ID(8);
    const d = draft('site_profile', 'create', tenant, { brandName: BI('S', 'س') });
    expect(overlayRow(null, d, siteProfile).row).toMatchObject({ tenant_id: tenant, version: 0 });
  });

  it('a delete is live, marked for removal', () => {
    const d = draft('service', 'delete', ID(1), {});
    const { row, draft: info } = overlayRow(live, d, service);
    expect(row).toMatchObject({ id: ID(1), slug: 'brand-film', pendingRemoval: true });
    expect(info.fields).toEqual([]);
  });

  it('an update whose row was removed on the live site says so', () => {
    const d = draft('service', 'update', ID(1), { title: BI('New', 'جديد') });
    const { row, draft: info } = overlayRow(null, d, service);
    expect(row).toBeNull();
    expect(info.liveMissing).toBe(true);
  });
});

describe('overlayList (decision D3)', () => {
  // A service list as listRows returns it (listColumns, raw).
  const liveRow = (n: number, slug: string, sortOrder: number, status = 'published') => ({
    id: ID(n),
    slug,
    title: BI(slug, slug),
    status,
    is_teaser: false,
    sort_order: sortOrder,
    discipline_id: ID(50),
    version: 1,
    updated_at: '2026-05-01T00:00:00.000Z',
  });
  const live = {
    rows: [liveRow(1, 'logo', 1), liveRow(2, 'letterhead', 2), liveRow(3, 'packaging', 3)],
    total: 12,
  };
  const create = (n: number, slug: string, extra: Record<string, unknown> = {}) =>
    draft('service', 'create', ID(n), {
      slug,
      title: BI(slug, slug),
      sortOrder: 0,
      disciplineId: ID(50),
      ...extra,
    });

  it('updates stay in place, deletes are badged, a reorder moves its row', () => {
    const drafts = [
      draft('service', 'update', ID(1), { sortOrder: 9, title: BI('Logo design', 'شعار') }),
      draft('service', 'delete', ID(2), {}),
    ];
    const { rows, total, invalid } = overlayList(live, drafts, {}, service);
    expect(rows.map((r) => r['slug'])).toEqual(['letterhead', 'packaging', 'logo']);
    expect(rows[2]).toMatchObject({ sort_order: 9, title: BI('Logo design', 'شعار') });
    expect(rows[2]!['draft']).toMatchObject({ op: 'update' });
    expect(rows[0]).toMatchObject({ pendingRemoval: true });
    expect(total).toBe(12);
    expect(invalid).toEqual([]);
    // Only the list's columns (as an untouched row has them): a patched body would not
    // leak into a list row.
    expect(Object.keys(rows[2]!).sort()).toEqual([...Object.keys(rows[1]!), 'draft'].sort());
  });

  it('creates matching the query join the first page, sorted in; total counts them all', () => {
    const drafts = [create(20, 'new-a'), create(21, 'new-b', { disciplineId: ID(51) })];
    const page1 = overlayList(
      live,
      drafts,
      { filters: { discipline_id: ID(50) }, offset: 0 },
      service,
    );
    expect(page1.rows.map((r) => r['slug'])).toEqual(['new-a', 'logo', 'letterhead', 'packaging']);
    expect(page1.rows[0]).toMatchObject({ id: ID(20), version: 0, status: 'draft' });
    expect(page1.total).toBe(13);

    const page2 = overlayList(
      live,
      drafts,
      { filters: { discipline_id: ID(50) }, offset: 50 },
      service,
    );
    expect(page2.rows.map((r) => r['slug'])).toEqual(['logo', 'letterhead', 'packaging']);
    expect(page2.total).toBe(13);
  });

  it('status filters, .neq exclusions and the search apply to creates as PostgREST would', () => {
    const drafts = [
      create(30, 'draft-one'),
      create(31, 'live-one', { status: 'published' }),
      create(32, 'brand-film'),
    ];
    const ids = (query: Parameters<typeof overlayList>[2]) =>
      overlayList({ rows: [], total: 0 }, drafts, query, service).rows.map((r) => r['slug']);
    expect(ids({ filters: { status: 'published' } })).toEqual(['live-one']);
    expect(ids({ exclude: { status: 'draft' } })).toEqual(['live-one']);
    expect(ids({ search: { column: 'slug', term: 'FILM' } })).toEqual(['brand-film']);
    // `%` and `_` are literal, as listRows escapes them.
    expect(ids({ search: { column: 'slug', term: '%' } })).toEqual([]);
    expect(ids({ search: { column: 'slug', term: '' } })).toHaveLength(3);
  });

  it('a NULL matches neither an equality nor a .neq', () => {
    const row = { status: 'draft', discipline_id: null };
    expect(matchesQuery(row, { exclude: { discipline_id: ID(1) } })).toBe(false);
    expect(matchesQuery(row, { filters: { discipline_id: ID(1) } })).toBe(false);
    expect(matchesQuery(row, { filters: { discipline_id: null } })).toBe(true);
    expect(matchesQuery({ visible: true }, { filters: { visible: 'true' } })).toBe(true);
    expect(
      matchesQuery({ title: { en: 'Logo' } }, { search: { column: 'title->>en', term: 'og' } }),
    ).toBe(true);
  });

  it('a newest-first list puts pending creates at the top (their updated_at is the draft’s)', () => {
    const cases = RELEASE_REGISTRY.service_case;
    const liveCases = {
      rows: [
        {
          id: ID(60),
          service_id: ID(1),
          portfolio_id: null,
          title: BI('Old', 'قديم'),
          is_placeholder: false,
          status: 'draft',
          version: 1,
          updated_at: '2026-05-01T00:00:00.000Z',
        },
      ],
      total: 1,
    };
    const d = draft('service_case', 'create', ID(61), {
      serviceId: ID(2),
      title: BI('Fresh', 'جديد'),
    });
    const { rows, total } = overlayList(
      liveCases,
      [d],
      { search: { column: 'title->>en', term: 'fre' } },
      cases,
    );
    expect(rows.map((r) => r['id'])).toEqual([ID(61), ID(60)]);
    expect(total).toBe(2);
  });

  it('a draft that no longer parses is left out and reported', () => {
    const bad = create(40, 'Not A Slug');
    const badUpdate = draft('service', 'update', ID(3), { slug: 'Not A Slug' });
    const { rows, invalid } = overlayList(live, [bad, badUpdate], {}, service);
    expect(invalid.sort()).toEqual([bad.id, badUpdate.id].sort());
    expect(rows.map((r) => r['slug'])).toEqual(['logo', 'letterhead', 'packaging']);
    expect(rows[2]).not.toHaveProperty('draft');
  });

  it('ignores drafts of other entity types', () => {
    const other = draft('discipline', 'create', ID(70), { slug: 'x', name: BI('X', 'س') });
    expect(overlayList(live, [other], {}, service).rows).toHaveLength(3);
  });
});

describe('review fixes (R2 review M2, L3, L4)', () => {
  const body = { en: DOC('Live body'), ar: DOC('نص') };
  const html = { en: '<p>Live body</p>', ar: '<p>نص</p>' };

  it('a list does not report a conflict on a column it did not select', () => {
    const base = { body, body_html: html, title: BI('Logo', 'شعار') };
    const d = draft(
      'service',
      'update',
      ID(1),
      { body: { en: DOC('Mine'), ar: DOC('لي') } },
      { base },
    );
    // The item read selects every column: base equals live, no conflict.
    const fullLive = {
      id: ID(1),
      slug: 'logo',
      title: BI('Logo', 'شعار'),
      body,
      body_html: html,
      version: 1,
    };
    expect(overlayRow(fullLive, d, service).draft.conflict).toBeUndefined();
    // The list selects a few: body and body_html are absent, not changed.
    const listRow = {
      id: ID(1),
      slug: 'logo',
      title: BI('Logo', 'شعار'),
      status: 'draft',
      sort_order: 1,
      version: 1,
    };
    const { rows } = overlayList({ rows: [listRow], total: 1 }, [d], {}, service);
    expect((rows[0]!['draft'] as { conflict?: string[] }).conflict).toBeUndefined();
    // When live really moved, the item read says so.
    const moved = { ...fullLive, body: { en: DOC('Someone else'), ar: DOC('آخر') } };
    expect(overlayRow(moved, d, service).draft.conflict).toEqual(['body']);
  });

  it('dropNoOps keeps a column live does not carry, and honours the base', () => {
    expect(dropNoOps({ og_image: null }, {})).toEqual({ og_image: null });
    // Equal to live and to its base: nothing to publish.
    expect(dropNoOps({ slug: 'a' }, { slug: 'a' }, { slug: 'a' })).toBeNull();
    // Equal to live, but live moved off the base: kept, so the conflict is resolved, not lost.
    expect(dropNoOps({ slug: 'a' }, { slug: 'a' }, { slug: 'b' })).toEqual({ slug: 'a' });
    // A column the base never recorded: live alone decides.
    expect(dropNoOps({ slug: 'a' }, { slug: 'a' }, { title: 'x' })).toBeNull();
  });

  it('live rows keep the database order; only changed and new rows are placed', () => {
    const theme = RELEASE_REGISTRY.custom_theme;
    const themeRow = (n: number, name: string) => ({
      id: ID(n),
      name,
      is_active: false,
      version: 1,
      updated_at: '2026-05-01T00:00:00.000Z',
    });
    // The database's collation put 'alpha' before 'Zeta' (JavaScript would not).
    const live = { rows: [themeRow(80, 'alpha'), themeRow(81, 'Zeta')], total: 2 };
    const names = (drafts: DraftInput[]) =>
      overlayList(live, drafts, {}, theme).rows.map((r) => r['name']);
    expect(names([])).toEqual(['alpha', 'Zeta']);
    expect(names([draft('custom_theme', 'update', ID(81), { isActive: true })])).toEqual([
      'alpha',
      'Zeta',
    ]);
    expect(names([draft('custom_theme', 'create', ID(82), { name: 'beta' })])).toEqual([
      'alpha',
      'Zeta',
      'beta',
    ]);
    expect(names([draft('custom_theme', 'update', ID(80), { name: 'zzz' })])).toEqual([
      'Zeta',
      'zzz',
    ]);
  });
});
