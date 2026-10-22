import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import type { Role } from '@/lib/auth/types';
import { client, T, type Db, type Row } from '../fixtures/stagedDb';
import { ADMIN, callRoute, draftRow, makeDb } from '../fixtures/stagedRoute';

// The publish and validate endpoints (Admin v2 R6) over the PostgREST stand-in: the selection as
// the person saw it, the per-change capabilities, the live re-read, the check over the state the
// selection leaves, the apply (dry run or publish) through the service client, its refusals
// mapped, and the after-effects never fatal. The apply itself is SQL (0051, pgTAP); here it is a
// scripted answer, and the request it receives is asserted.

const svc = vi.hoisted(() => ({
  db: null as unknown as Db,
  calls: [] as { fn: string; args: Record<string, unknown> }[],
  answer: (() => ({ data: null, error: null })) as (
    fn: string,
    args: Record<string, unknown>,
  ) => { data: unknown; error: unknown },
  logs: [] as Record<string, unknown>[],
}));

vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({
    // The person, re-read live, and the account links: the stand-in's own tables.
    from: (table: string) => client(svc.db).from(table),
    // A builder like postgrest-js's: awaitable, and `abortSignal()` returns the same answer.
    rpc: (fn: string, args: Record<string, unknown>) => {
      svc.calls.push({ fn, args });
      const answer = () => Promise.resolve().then(() => svc.answer(fn, args));
      return {
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => answer().then(ok, ko),
        abortSignal: () => answer(),
      };
    },
  }),
}));
vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async (entry: Record<string, unknown>) => {
    svc.logs.push(entry);
    return true;
  },
}));
// The edge snapshots, rebuilt after a release AS THE SYSTEM (Admin v2 R7): the service client
// and the release's tenant, whoever published. Counted here, with the tenant they were given.
const syncs = vi.hoisted(() => ({ redirects: 0, visibility: 0, tenants: [] as string[] }));
vi.mock('@/lib/admin/redirectSync', () => ({
  syncRedirectsOfTenant: async (_sb: unknown, tenantId: string) => {
    syncs.redirects += 1;
    syncs.tenants.push(tenantId);
    return { kvSynced: true, count: 1, truncated: false };
  },
}));
vi.mock('@/lib/admin/visibilitySync', () => ({
  rebuildVisibilitySnapshot: async (_sb: unknown, tenantId: string) => {
    syncs.visibility += 1;
    syncs.tenants.push(tenantId);
    return { snapshot: {}, kvSynced: false };
  },
}));

const { POST: PUBLISH } = await import('@/pages/api/admin/releases/index');
const { POST: VALIDATE } = await import('@/pages/api/admin/releases/validate');
const { RELEASE_REGISTRY } = await import('@/lib/release/registry');
const { RELEASE_LINKS } = await import('@/lib/release/links');

const BI = (en: string, ar: string) => ({ en, ar });
const OTHER_TENANT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const id = (n: number) => `0f0f0f0f-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SERVICE = id(1);
const DISCIPLINE = id(2);
const DRAFT_DISCIPLINE = id(3);
const POSTER = id(4);
const PAGE = id(5);
const SECTION = id(6);
const NEW_SERVICE = id(7);
const NEW_CASE = id(8);
const FOREIGN_CLIENT = id(9);
const PROJECT = id(10);
const draftId = (n: number) => `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`;

const liveService = (over: Row = {}): Row => ({
  id: SERVICE,
  tenant_id: T,
  slug: 'logo',
  title: BI('Logo Design', 'تصميم الشعار'),
  status: 'published',
  discipline_id: DISCIPLINE,
  poster_media_id: null,
  version: 3,
  ...over,
});

function seed(tables: Record<string, Row[]> = {}): Db {
  const db = makeDb({
    profiles: [{ id: ADMIN, tenant_id: T, role: 'admin', is_active: true, locked_until: null }],
    services: [liveService()],
    disciplines: [
      { id: DISCIPLINE, tenant_id: T, slug: 'branding', status: 'published', version: 1 },
    ],
    media_assets: [{ id: POSTER, tenant_id: T, kind: 'image', alt: BI('Poster', 'ملصق') }],
    clients: [{ id: FOREIGN_CLIENT, tenant_id: OTHER_TENANT, slug: 'other', version: 1 }],
    pages: [{ id: PAGE, tenant_id: T, slug: 'about', status: 'published', version: 1 }],
    page_sections: [
      { id: SECTION, tenant_id: T, page_id: PAGE, type: 'text', sort_order: 1, version: 1 },
    ],
    redirects: [],
    entity_seo: [],
    site_profile: [],
    ...tables,
  });
  svc.db = db;
  return db;
}

/** A pending edit of the live service. */
const serviceEdit = (payload: Row, base: Row, over: Row = {}) =>
  draftRow({
    id: draftId(1),
    entity_type: 'service',
    entity_id: SERVICE,
    op: 'update',
    payload,
    base,
    label: { en: 'Logo Design' },
    ...over,
  });

const select = (...drafts: Row[]) => ({
  items: drafts.map((d) => ({ draftId: d['id'], draftVersion: d['version'] })),
});

const applyCalls = () => svc.calls.filter((c) => c.fn === 'apply_release');

async function run(
  route: APIRoute,
  db: Db,
  body: unknown,
  role: Role = 'admin',
  path = '/api/admin/releases',
) {
  if (role !== 'admin') {
    db.tables['profiles'] = [
      { id: ADMIN, tenant_id: T, role, is_active: true, locked_until: null },
    ];
  }
  return callRoute(db, route, 'POST', path, { body, role });
}

/** One item of the apply's answer: the row it changed, before and after. */
const applied = (
  entityType: string,
  entityId: string,
  op: 'create' | 'update' | 'delete',
  before: Row | null,
  after: Row | null,
) => ({
  id: 1,
  tenant_id: T,
  release_id: id(99),
  entity_type: entityType,
  entity_id: entityId,
  op,
  before,
  after,
  draft_id: null,
  actor_id: ADMIN,
  created_at: '2026-10-22T10:00:00+00:00',
});
const published = (number = 7, items: unknown[] = []) => ({
  data: { release_id: id(99), number, items },
  error: null,
});
const dryOk = (n: number) => ({
  data: { mode: 'dry_run', ok: true, item_count: n, conflicts: [], errors: [] },
  error: null,
});

beforeEach(() => {
  svc.calls = [];
  svc.logs = [];
  svc.answer = (fn) => (fn === 'record_release_purge' ? { data: null, error: null } : published());
  syncs.redirects = 0;
  syncs.visibility = 0;
  syncs.tenants = [];
});

describe('releases off (every tenant until R14)', () => {
  it('both routes answer 409 and read nothing else', async () => {
    const db = seed({ content_drafts: [serviceEdit({ title: BI('A', 'ب') }, {})] });
    db.flag = false;
    for (const route of [PUBLISH, VALIDATE]) {
      const res = await run(route, db, select(serviceEdit({}, {})));
      expect(res.status).toBe(409);
      expect(res.body['error']).toBe('releases-off');
    }
    expect(db.calls.filter((c) => c.kind === 'from')).toEqual([]);
    expect(applyCalls()).toEqual([]);
  });
});

describe('the selection, the capabilities and the person', () => {
  it('a change that moved since the person saw it is 409 pending-changed, naming it', async () => {
    const draft = serviceEdit(
      { title: BI('A', 'ب') },
      { title: BI('Logo Design', 'تصميم الشعار') },
    );
    const db = seed({ content_drafts: [draft] });
    const res = await run(PUBLISH, db, {
      items: [{ draftId: draft['id'], draftVersion: 2 }],
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'pending-changed', draftIds: [draft['id']] });
    expect(applyCalls()).toEqual([]);
  });

  it('a change claimed by a scheduled release cannot be published now', async () => {
    const draft = serviceEdit({ title: BI('A', 'ب') }, {}, { release_id: id(98) });
    const res = await run(PUBLISH, seed({ content_drafts: [draft] }), select(draft));
    expect(res.status).toBe(409);
    expect(res.body['error']).toBe('pending-changed');
  });

  it('a Content Creator may not publish an archive: 403 naming the draft and who could', async () => {
    const draft = serviceEdit({ status: 'archived' }, { status: 'published' });
    const res = await run(
      PUBLISH,
      seed({ content_drafts: [draft] }),
      select(draft),
      'content_creator',
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: 'forbidden',
      capability: 'content.archiveDelete',
      draftIds: [draft['id']],
      waitingFor: { [String(draft['id'])]: ['admin'] },
    });
    expect(applyCalls()).toEqual([]);
  });

  // Hotfix H12: the apply runs as the publisher and the archive gates refuse anyone but an
  // Admin an update that leaves a row archived, so a change to a row archived live that sets
  // no status (a number, a title) waits for an Admin, as an archive does. Before, canPublish
  // saw no archive in it: a Content Creator was told they could publish it, and the apply
  // was refused whole.
  it('a Content Creator may not publish an edit of a row archived live: 403, waiting for an Admin', async () => {
    const draft = serviceEdit({ sortOrder: 5 }, { sort_order: 10 });
    for (const route of [PUBLISH, VALIDATE]) {
      const db = seed({
        services: [liveService({ status: 'archived', sort_order: 10 })],
        content_drafts: [draft],
      });
      const res = await run(route, db, select(draft), 'content_creator');
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        error: 'forbidden',
        capability: 'content.archiveDelete',
        draftIds: [draft['id']],
        waitingFor: { [String(draft['id'])]: ['admin'] },
      });
    }
    expect(applyCalls()).toEqual([]);
  });

  it('an Admin publishes that edit; a Content Creator publishes a restore of the same row', async () => {
    const edit = serviceEdit({ sortOrder: 5 }, { sort_order: 10 });
    const db = seed({
      services: [liveService({ status: 'archived', sort_order: 10 })],
      content_drafts: [edit],
    });
    const admin = await run(PUBLISH, db, select(edit));
    expect(admin.status, JSON.stringify(admin.body)).toBe(200);
    expect(applyCalls()).toHaveLength(1);

    svc.calls = [];
    const restore = serviceEdit({ status: 'draft' }, { status: 'archived' });
    const cc = await run(
      PUBLISH,
      seed({
        services: [liveService({ status: 'archived' })],
        content_drafts: [restore],
      }),
      select(restore),
      'content_creator',
    );
    expect(cc.status, JSON.stringify(cc.body)).toBe(200);
    expect(applyCalls()).toHaveLength(1);
  });

  it('SEO may not publish content, Developer may not publish a service', async () => {
    const draft = serviceEdit(
      { title: BI('A', 'ب') },
      { title: BI('Logo Design', 'تصميم الشعار') },
    );
    for (const role of ['seo', 'developer'] as const) {
      const res = await run(VALIDATE, seed({ content_drafts: [draft] }), select(draft), role);
      expect(res.status).toBe(403);
    }
  });

  it('a person demoted since the token was issued is refused before anything is checked', async () => {
    const draft = serviceEdit(
      { title: BI('A', 'ب') },
      { title: BI('Logo Design', 'تصميم الشعار') },
    );
    const db = seed({ content_drafts: [draft] });
    db.tables['profiles'] = [
      { id: ADMIN, tenant_id: T, role: 'seo', is_active: true, locked_until: null },
    ];
    const res = await callRoute(db, PUBLISH, 'POST', '/api/admin/releases', {
      body: select(draft),
      role: 'admin',
    });
    expect(res.status).toBe(403);
    expect(res.body['capability']).toBe('live-recheck');
    expect(applyCalls()).toEqual([]);
  });

  it('a removal no role may publish (a singleton) is 403', async () => {
    const draft = draftRow({ id: draftId(2), entity_type: 'site_profile', op: 'delete' });
    const res = await run(PUBLISH, seed({ content_drafts: [draft] }), select(draft));
    expect(res.status).toBe(403);
  });

  it('a rollback is refused until versions can be restored (R10)', async () => {
    const draft = serviceEdit({ title: BI('A', 'ب') }, {});
    const res = await run(PUBLISH, seed({ content_drafts: [draft] }), {
      ...select(draft),
      kind: 'rollback',
    });
    expect(res.status).toBe(422);
    expect(res.body['field']).toBe('kind');
  });
});

describe('the check (validate)', () => {
  it('a clean edit: the dry run gets the patch and the draft’s own base, as stored', async () => {
    // A base read from PostgREST keeps its microseconds: R4 compares it typed, so the Worker
    // must hand it on untouched, never re-derive it.
    const draft = serviceEdit(
      { title: BI('Logo', 'شعار') },
      { title: BI('Logo Design', 'تصميم الشعار'), consent_at: '2026-10-18T08:00:00.123456+00:00' },
    );
    svc.answer = () => dryOk(1);
    const res = await run(
      VALIDATE,
      seed({ content_drafts: [draft] }),
      select(draft),
      'admin',
      '/api/admin/releases/validate',
    );
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ ok: true, dryRun: 'ran', errors: [] });
    const [call] = applyCalls();
    expect(call!.args).toMatchObject({
      p_actor: ADMIN,
      p_role: 'admin',
      p_mode: 'dry_run',
      p_kind: 'publish',
      p_items: [
        {
          draft_id: draft['id'],
          draft_version: 1,
          entity_type: 'service',
          entity_id: SERVICE,
          op: 'update',
          patch: { title: BI('Logo', 'شعار') },
          base: { title: BI('Logo Design', 'تصميم الشعار') },
        },
      ],
    });
  });

  it('the bilingual rule binds on what the release leaves live', async () => {
    // Publishing a draft service whose live title has no Arabic: the rule reads the row the
    // release leaves (live ⊕ change), not the change alone.
    const draft = serviceEdit({ status: 'published' }, { status: 'draft' });
    const db = seed({
      content_drafts: [draft],
      services: [liveService({ status: 'draft', title: { en: 'Logo', ar: '' } })],
    });
    const res = await run(VALIDATE, db, select(draft));
    expect(res.data).toMatchObject({ ok: false, dryRun: 'skipped' });
    const [item] = res.data['items'] as Row[];
    expect((item!['errors'] as Row[])[0]).toMatchObject({ code: 'invalid' });
    expect(applyCalls()).toEqual([]);
  });

  it('a stored change that no longer reads (written around the API) is reported, not applied', async () => {
    const draft = serviceEdit(
      { title: { en: 'Logo', ar: '' } },
      { title: BI('Logo Design', 'تصميم الشعار') },
    );
    const res = await run(VALIDATE, seed({ content_drafts: [draft] }), select(draft));
    const [item] = res.data['items'] as Row[];
    expect(item!['errors']).toEqual([expect.objectContaining({ code: 'unreadable' })]);
    expect(applyCalls()).toEqual([]);
  });

  it('a link to another tenant’s row is refused on its field', async () => {
    const draft = draftRow({
      id: draftId(3),
      entity_type: 'portfolio',
      entity_id: PROJECT,
      op: 'update',
      payload: { clientId: FOREIGN_CLIENT },
      base: { client_id: null },
    });
    const db = seed({
      content_drafts: [draft],
      portfolio: [
        { id: PROJECT, tenant_id: T, slug: 'p', status: 'draft', client_id: null, version: 1 },
      ],
    });
    const res = await run(VALIDATE, db, select(draft));
    const [item] = res.data['items'] as Row[];
    expect(item!['errors']).toEqual([expect.objectContaining({ code: 'link', field: 'clientId' })]);
  });

  it('a link to a pending new item left out is a dependency; ticking it clears it', async () => {
    const service = draftRow({
      id: draftId(4),
      entity_type: 'service',
      entity_id: NEW_SERVICE,
      op: 'create',
      payload: { slug: 'motion', title: BI('Motion', 'حركة'), status: 'draft' },
      base: {},
      base_version: null,
      label: { en: 'Motion' },
    });
    const caseBlock = draftRow({
      id: draftId(5),
      entity_type: 'service_case',
      entity_id: NEW_CASE,
      op: 'create',
      payload: { serviceId: NEW_SERVICE, title: BI('Case', 'حالة'), status: 'draft' },
      base: {},
      base_version: null,
    });
    const db = seed({ content_drafts: [service, caseBlock] });
    const alone = await run(VALIDATE, db, select(caseBlock));
    const [item] = alone.data['items'] as Row[];
    expect(item!['requires']).toEqual([{ draftId: service['id'], draftVersion: 1 }]);
    expect(item!['errors']).toEqual([
      expect.objectContaining({ code: 'requires', field: 'serviceId' }),
    ]);
    expect(String((item!['errors'] as Row[])[0]!['message'])).toContain('Motion');

    svc.answer = () => dryOk(2);
    const both = await run(VALIDATE, db, select(service, caseBlock));
    expect(both.data).toMatchObject({ ok: true });
    expect(
      (both.data['items'] as Row[]).every((i) => (i['requires'] as unknown[]).length === 0),
    ).toBe(true);
  });

  it('a change whose page the same release removes is refused (edge case 3)', async () => {
    const page = draftRow({ id: draftId(6), entity_type: 'page', entity_id: PAGE, op: 'delete' });
    const section = draftRow({
      id: draftId(7),
      entity_type: 'page_section',
      entity_id: SECTION,
      op: 'update',
      payload: { sortOrder: 4 },
      base: { sort_order: 1 },
    });
    const res = await run(
      VALIDATE,
      seed({ content_drafts: [page, section] }),
      select(page, section),
    );
    const items = res.data['items'] as Row[];
    expect(items.find((i) => i['draftId'] === section['id'])!['errors']).toEqual([
      expect.objectContaining({ code: 'parent-removed', field: 'pageId' }),
    ]);
    expect(items.find((i) => i['draftId'] === page['id'])!['errors']).toEqual([]);
  });

  it('a redirect from a slug the same release renames passes; alone it is refused', async () => {
    const rename = serviceEdit({ slug: 'logo-design' }, { slug: 'logo' });
    const redirect = draftRow({
      id: draftId(8),
      entity_type: 'redirect',
      entity_id: id(20),
      op: 'create',
      payload: { sourcePath: '/services/logo', targetPath: '/services/logo-design' },
      base: {},
      base_version: null,
    });
    const db = seed({ content_drafts: [rename, redirect] });
    const alone = await run(VALIDATE, db, select(redirect));
    const [item] = alone.data['items'] as Row[];
    expect(item!['errors']).toEqual([
      expect.objectContaining({ code: 'invalid', field: 'sourcePath' }),
    ]);

    svc.answer = () => dryOk(2);
    const together = await run(VALIDATE, db, select(rename, redirect));
    expect(together.data).toMatchObject({ ok: true, dryRun: 'ran' });
  });

  it('a first save of the identity whose row has since appeared is reported (R3b, 3)', async () => {
    const draft = draftRow({
      id: draftId(9),
      entity_type: 'site_profile',
      entity_id: T,
      op: 'create',
      payload: { brandName: BI('Studio', 'استوديو') },
      base: {},
      base_version: null,
    });
    const db = seed({
      content_drafts: [draft],
      site_profile: [
        { tenant_id: T, brand_name: BI('Live', 'حي'), accepting_applications: true, version: 1 },
      ],
    });
    const res = await run(VALIDATE, db, select(draft));
    const [item] = res.data['items'] as Row[];
    expect(item!['errors']).toEqual([expect.objectContaining({ code: 'exists-live' })]);
  });

  it('new search settings for a page that gained some by another path are reported (R3b, 4)', async () => {
    const draft = draftRow({
      id: draftId(10),
      entity_type: 'entity_seo',
      entity_id: id(30),
      op: 'create',
      payload: {
        entityType: 'service',
        entityId: SERVICE,
        metaTitle: BI('Logo', 'شعار'),
        metaDescription: BI('Logo design', 'تصميم شعار'),
      },
      base: {},
      base_version: null,
    });
    const db = seed({
      content_drafts: [draft],
      entity_seo: [
        { id: id(31), tenant_id: T, entity_type: 'service', entity_id: SERVICE, version: 1 },
      ],
    });
    const res = await run(VALIDATE, db, select(draft), 'seo');
    const [item] = res.data['items'] as Row[];
    expect(item!['errors']).toEqual([expect.objectContaining({ code: 'exists-live' })]);
  });

  it('a published service under an unpublished discipline warns, and still publishes', async () => {
    const draft = serviceEdit({ disciplineId: DRAFT_DISCIPLINE }, { discipline_id: DISCIPLINE });
    const db = seed({ content_drafts: [draft] });
    db.tables['disciplines']!.push({
      id: DRAFT_DISCIPLINE,
      tenant_id: T,
      status: 'draft',
      version: 1,
    });
    svc.answer = () => dryOk(1);
    const res = await run(VALIDATE, db, select(draft));
    expect(res.data).toMatchObject({ ok: true });
    const [item] = res.data['items'] as Row[];
    expect(item!['warnings']).toEqual([expect.objectContaining({ code: 'hidden-by-discipline' })]);
  });

  it('a poster without Arabic alt text stops a case study going live', async () => {
    const media = id(40);
    const draft = draftRow({
      id: draftId(11),
      entity_type: 'portfolio',
      entity_id: PROJECT,
      op: 'update',
      payload: { posterMediaId: media },
      base: { poster_media_id: null },
    });
    const db = seed({
      content_drafts: [draft],
      portfolio: [
        {
          id: PROJECT,
          tenant_id: T,
          slug: 'p',
          status: 'published',
          title: BI('P', 'ب'),
          project_type: BI('Film', 'فيلم'),
          is_placeholder: false,
          results: [],
          version: 1,
        },
      ],
    });
    db.tables['media_assets']!.push({
      id: media,
      tenant_id: T,
      kind: 'image',
      alt: { en: 'Only English' },
    });
    const res = await run(VALIDATE, db, select(draft));
    const [item] = res.data['items'] as Row[];
    expect(item!['errors']).toEqual([
      expect.objectContaining({ code: 'invalid', field: 'posterMediaId' }),
    ]);
  });

  it('the database’s dry-run refusals land on their change and field, never its words', async () => {
    const draft = serviceEdit({ slug: 'taken' }, { slug: 'logo' });
    svc.answer = () => ({
      data: {
        mode: 'dry_run',
        ok: false,
        item_count: 1,
        conflicts: [],
        errors: [
          {
            draftId: draft['id'],
            sqlstate: '23505',
            constraint: 'services_tenant_id_slug_key',
            column: null,
            message: 'duplicate key value violates unique constraint (secret detail)',
          },
        ],
      },
      error: null,
    });
    const res = await run(VALIDATE, seed({ content_drafts: [draft] }), select(draft));
    expect(res.data).toMatchObject({ ok: false, dryRun: 'ran' });
    const [item] = res.data['items'] as Row[];
    expect(item!['errors']).toEqual([expect.objectContaining({ code: 'refused', field: 'slug' })]);
    expect(JSON.stringify(res.body)).not.toContain('secret detail');
  });

  it('a dry-run conflict carries the live and base values for Compare', async () => {
    const draft = serviceEdit({ title: BI('Logo', 'شعار') }, { title: BI('Old', 'قديم') });
    svc.answer = () => ({
      data: {
        mode: 'dry_run',
        ok: false,
        item_count: 1,
        errors: [],
        conflicts: [
          {
            draftId: draft['id'],
            columns: ['title'],
            live: { title: BI('Logo Design', 'تصميم الشعار') },
            base: { title: BI('Old', 'قديم') },
          },
        ],
      },
      error: null,
    });
    const res = await run(VALIDATE, seed({ content_drafts: [draft] }), select(draft));
    const [item] = res.data['items'] as Row[];
    expect(item!['conflict']).toMatchObject({ columns: ['title'] });
    expect(item!['errors']).toEqual([expect.objectContaining({ code: 'conflict' })]);
  });
});

describe('publishing', () => {
  it('a clean release: applied as the publisher, its tags recorded, the purge a logged no-op', async () => {
    const draft = serviceEdit(
      { title: BI('Logo', 'شعار') },
      { title: BI('Logo Design', 'تصميم الشعار') },
    );
    svc.answer = (fn) =>
      fn === 'record_release_purge'
        ? { data: null, error: null }
        : published(7, [applied('service', SERVICE, 'update', { slug: 'logo' }, { slug: 'logo' })]);
    const db = seed({ content_drafts: [draft] });
    const res = await run(PUBLISH, db, { ...select(draft), note: 'Spring copy' });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      release: { id: id(99), number: 7 },
      items: [{ entityType: 'service', entityId: SERVICE, op: 'update' }],
      purge: 'skipped',
    });
    expect(applyCalls()[0]!.args).toMatchObject({ p_mode: 'publish', p_note: 'Spring copy' });
    const purge = svc.calls.find((c) => c.fn === 'record_release_purge');
    expect(purge!.args).toMatchObject({
      p_tenant: T,
      p_release: id(99),
      p_status: 'skipped',
      p_next_at: null,
    });
    // The service's page, the lists, the sitemap and llms.txt (Admin v2 R7).
    expect([...(purge!.args['p_tags'] as string[])].sort()).toEqual(
      ['route:llms', 'route:sitemap', 'service:logo', 'services:all'].sort(),
    );
    expect(svc.logs).toContainEqual(
      expect.objectContaining({ level: 'info', source: 'release:purge' }),
    );
    expect(syncs).toMatchObject({ redirects: 0, visibility: 0 });
    // No purge was sent, so no release.purge row.
    expect((db.tables['audit_log'] ?? []).map((r) => r['action'])).not.toContain('release.purge');
  });

  it('a release of redirects only: the edge map rebuilt as the system, nothing to purge', async () => {
    const redirect = draftRow({
      id: draftId(12),
      entity_type: 'redirect',
      entity_id: id(21),
      op: 'create',
      payload: { sourcePath: '/old-page', targetPath: '/services' },
      base: {},
      base_version: null,
    });
    svc.answer = (fn) =>
      fn === 'record_release_purge'
        ? { data: null, error: { code: 'XX000', message: 'down' } }
        : published(8, [
            applied('redirect', id(21), 'create', null, {
              source_path: '/old-page',
              target_path: '/services',
            }),
          ]);
    const res = await run(PUBLISH, seed({ content_drafts: [redirect] }), select(redirect), 'seo');
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ release: { number: 8 }, kvSynced: true, purge: 'not_needed' });
    expect(syncs.redirects).toBe(1);
    expect(syncs.tenants).toEqual([T]);
    // A failed purge record is only logged.
    expect(svc.logs).toContainEqual(
      expect.objectContaining({ level: 'error', source: 'release:purge' }),
    );
  });

  it('a page edit that keeps its slug rebuilds no snapshot', async () => {
    const draft = draftRow({
      id: draftId(13),
      entity_type: 'page',
      entity_id: PAGE,
      op: 'update',
      payload: { title: BI('About us', 'من نحن') },
      base: { title: BI('About', 'عنا') },
    });
    svc.answer = (fn) =>
      fn === 'record_release_purge'
        ? { data: null, error: null }
        : published(7, [applied('page', PAGE, 'update', { slug: 'about' }, { slug: 'about' })]);
    const res = await run(
      PUBLISH,
      seed({ content_drafts: [draft] }),
      select(draft),
      'content_creator',
    );
    expect(res.status).toBe(200);
    expect(syncs).toMatchObject({ redirects: 0, visibility: 0 });
    expect(res.data['kvSynced']).toBeUndefined();
  });

  it('a page renamed by a Content Creator: the visibility snapshot rebuilt as the system (R6 question 2)', async () => {
    // The snapshot names pages by slug: a hidden page renamed would otherwise be public at the
    // edge under its new name until the daily re-sync.
    const draft = draftRow({
      id: draftId(16),
      entity_type: 'page',
      entity_id: PAGE,
      op: 'update',
      payload: { slug: 'who-we-are' },
      base: { slug: 'about' },
    });
    svc.answer = (fn) =>
      fn === 'record_release_purge'
        ? { data: null, error: null }
        : published(7, [
            applied('page', PAGE, 'update', { slug: 'about' }, { slug: 'who-we-are' }),
          ]);
    const db = seed({
      content_drafts: [draft],
      pages: [
        {
          id: PAGE,
          tenant_id: T,
          slug: 'about',
          title: BI('About', 'عنا'),
          status: 'published',
          version: 1,
        },
      ],
    });
    const res = await run(PUBLISH, db, select(draft), 'content_creator');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(syncs).toMatchObject({ redirects: 0, visibility: 1, tenants: [T] });
    expect(res.data['kvSynced']).toBe(false);
    const purge = svc.calls.find((c) => c.fn === 'record_release_purge');
    expect(purge!.args['p_tags']).toEqual(
      expect.arrayContaining(['page:about', 'page:who-we-are']),
    );
  });

  it('a page-visibility change rebuilds the snapshot, and says when the edge missed it', async () => {
    const draft = draftRow({
      id: draftId(14),
      entity_type: 'page_visibility',
      entity_id: id(50),
      op: 'update',
      payload: { target: { pageId: PAGE }, mode: 'hidden', redirectPageId: null },
      base: { mode: 'public', redirect_page_id: null, hide_from: null, show_on: null },
    });
    const db = seed({
      content_drafts: [draft],
      page_visibility: [
        { id: id(50), tenant_id: T, page_id: PAGE, template: null, mode: 'public', version: 1 },
      ],
    });
    svc.answer = (fn) =>
      fn === 'record_release_purge'
        ? { data: null, error: null }
        : published(7, [
            applied(
              'page_visibility',
              id(50),
              'update',
              { page_id: PAGE, mode: 'public' },
              { page_id: PAGE, mode: 'hidden' },
            ),
          ]);
    const res = await run(PUBLISH, db, select(draft), 'developer');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(syncs.visibility).toBe(1);
    expect(res.data['kvSynced']).toBe(false);
    // The page's slug read in one request, as the publisher (release_read_rows).
    const purge = svc.calls.find((c) => c.fn === 'record_release_purge');
    expect(purge!.args['p_tags']).toEqual(expect.arrayContaining(['page:about', 'nav:all']));
  });

  it('nothing is applied while the check finds something to fix (422 with the check)', async () => {
    const draft = serviceEdit({ status: 'published' }, { status: 'draft' });
    const db = seed({
      content_drafts: [draft],
      services: [liveService({ status: 'draft', title: { en: 'Logo', ar: '' } })],
    });
    const res = await run(PUBLISH, db, select(draft));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: 'validation',
      check: { ok: false, dryRun: 'skipped' },
    });
    expect(applyCalls()).toEqual([]);
  });

  const refusedWith = async (error: Row) => {
    const draft = serviceEdit(
      { title: BI('Logo', 'شعار') },
      { title: BI('Logo Design', 'تصميم الشعار') },
    );
    svc.answer = () => ({ data: null, error });
    return { draft, res: await run(PUBLISH, seed({ content_drafts: [draft] }), select(draft)) };
  };

  it('BR403 (the database re-read the person) is 403', async () => {
    const { res } = await refusedWith({ code: 'BR403', message: 'x', details: '{"code":"actor"}' });
    expect(res.status).toBe(403);
  });

  it('BR409 pending-changed and conflict are 409, mapped to the changes', async () => {
    const one = await refusedWith({
      code: 'BR409',
      message: 'x',
      details: JSON.stringify({ code: 'pending-changed', draftIds: [draftId(1)] }),
    });
    expect(one.res.status).toBe(409);
    expect(one.res.body).toMatchObject({ error: 'pending-changed', draftIds: [draftId(1)] });

    const two = await refusedWith({
      code: 'BR409',
      message: 'x',
      details: JSON.stringify({
        code: 'conflict',
        items: [{ draftId: draftId(1), columns: ['title'] }],
      }),
    });
    expect(two.res.status).toBe(409);
    expect(two.res.body).toMatchObject({ error: 'conflict' });
    const check = two.res.body['check'] as Row;
    expect((check['items'] as Row[])[0]!['conflict']).toEqual({
      draftId: draftId(1),
      columns: ['title'],
    });
  });

  it('BR422 is 422 with the refusal on its field; base-missing is named', async () => {
    const one = await refusedWith({
      code: 'BR422',
      message: 'x',
      details: JSON.stringify({
        code: 'refused',
        items: [
          {
            draftId: draftId(1),
            sqlstate: '23514',
            constraint: null,
            column: 'title',
            message: 'new row violates check constraint',
          },
        ],
      }),
    });
    expect(one.res.status).toBe(422);
    const item = ((one.res.body['check'] as Row)['items'] as Row[])[0]!;
    expect(item['errors']).toEqual([expect.objectContaining({ code: 'refused', field: 'title' })]);

    const two = await refusedWith({
      code: 'BR422',
      message: 'x',
      details: JSON.stringify({ code: 'base-missing', draftId: draftId(1), columns: ['title'] }),
    });
    expect(two.res.status).toBe(422);
    const item2 = ((two.res.body['check'] as Row)['items'] as Row[])[0]!;
    expect(item2['errors']).toEqual([expect.objectContaining({ code: 'base-missing' })]);
  });

  it('a busy database (lock wait, deadlock, serialization, timeout) is 503 with Retry-After', async () => {
    for (const code of ['55P03', '40P01', '40001', '57014']) {
      const { res } = await refusedWith({ code, message: 'busy' });
      expect(res.status, code).toBe(503);
      expect(res.body['error']).toBe('busy');
    }
  });

  it('an apply the Worker stopped waiting for is 503 busy, never a 500', async () => {
    // postgrest-js resolves an aborted call (status 0, an empty code); it does not throw.
    const aborted = {
      code: '',
      message: 'TimeoutError: The operation was aborted due to timeout',
      details: '',
      hint: 'Request was aborted (timeout or manual cancellation)',
    };
    const draft = serviceEdit(
      { title: BI('Logo', 'شعار') },
      { title: BI('Logo Design', 'تصميم الشعار') },
    );
    svc.answer = () => ({ data: null, error: aborted, status: 0 }) as never;
    const res = await run(PUBLISH, seed({ content_drafts: [draft] }), select(draft));
    expect(res.status).toBe(503);
    expect(res.body['error']).toBe('busy');
    expect(res.headers.get('Retry-After')).toBe('5');
    expect(svc.logs).toContainEqual(
      expect.objectContaining({ level: 'error', source: 'release:apply' }),
    );
  });

  it('an apply that committed after the Worker stopped waiting still runs its after-effects', async () => {
    // A release that hid a page must not leave it public at the edge until the daily re-sync.
    const draft = draftRow({
      id: draftId(15),
      entity_type: 'page_visibility',
      entity_id: id(51),
      op: 'update',
      payload: { target: { pageId: PAGE }, mode: 'hidden', redirectPageId: null },
      base: { mode: 'public', redirect_page_id: null, hide_from: null, show_on: null },
    });
    const db = seed({
      content_drafts: [draft],
      page_visibility: [
        { id: id(51), tenant_id: T, page_id: PAGE, template: null, mode: 'public', version: 1 },
      ],
      content_releases: [
        { id: id(97), tenant_id: OTHER_TENANT, number: 3, status: 'published' },
        { id: id(98), tenant_id: T, number: 9, status: 'published' },
      ],
      content_release_items: [
        { id: 1, tenant_id: OTHER_TENANT, release_id: id(97), draft_id: draftId(15) },
        { id: 2, tenant_id: T, release_id: id(98), draft_id: draftId(15) },
      ],
    });
    svc.answer = (fn) =>
      fn === 'apply_release'
        ? ({
            data: null,
            error: { code: '', message: 'TimeoutError: aborted' },
            status: 0,
          } as never)
        : { data: null, error: null };
    const res = await run(PUBLISH, db, select(draft), 'developer');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.data).toMatchObject({ release: { id: id(98), number: 9 }, purge: 'skipped' });
    // Its items are not known: both snapshots rebuilt as the system, the whole site purged.
    expect(syncs).toMatchObject({ redirects: 1, visibility: 1, tenants: [T, T] });
    const records = svc.calls.filter((c) => c.fn === 'record_release_purge');
    expect(records).toHaveLength(1);
    expect(records[0]!.args['p_tags']).toEqual(['tenant:default']);
  });

  it('releases switched off between the flag read and the apply (55000) is 409 releases-off', async () => {
    const { res } = await refusedWith({ code: '55000', message: 'off' });
    expect(res.status).toBe(409);
    expect(res.body['error']).toBe('releases-off');
  });

  it('an unexpected refusal is a 500 that says nothing of the database', async () => {
    const { res } = await refusedWith({ code: '22023', message: 'column "x" is not allowlisted' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('allowlisted');
  });
});

describe('the Free plan’s 50 subrequests (P-15)', () => {
  // A clean publish touching every registry type, end to end (Admin v2 R7, O-16): measured at
  // 26 on the merged tree (2026-10-22), plus the one slug read a release whose images do not
  // carry its pages' slugs adds. A cache zone's purge adds at most 4 more (the budget read, the
  // request and its one retry, the release.purge row): 31, under the Free plan's 50.
  const MAX_PUBLISH = 27;
  const PURGE_SET_UP = 4;
  it('a 60-change release of linked services costs a handful of reads, not one per rule', async () => {
    const services: Row[] = [];
    const drafts: Row[] = [];
    for (let n = 0; n < 60; n += 1) {
      const sid = id(1000 + n);
      services.push(liveService({ id: sid, slug: `s${n}`, poster_media_id: null }));
      drafts.push(
        draftRow({
          id: draftId(1000 + n),
          entity_type: 'service',
          entity_id: sid,
          op: 'update',
          payload: { disciplineId: DISCIPLINE, posterMediaId: POSTER },
          base: { discipline_id: DISCIPLINE, poster_media_id: null },
        }),
      );
    }
    const db = seed({ services, content_drafts: drafts });
    svc.answer = () => dryOk(60);
    const res = await run(VALIDATE, db, select(...drafts));
    expect(res.data).toMatchObject({ ok: true });
    const reads = db.calls.length + svc.calls.length;
    expect(reads).toBeLessThanOrEqual(12);
  });

  it('posts published by several authors read the authors once, not once per author (U8b, D11)', async () => {
    // Twelve posts by four authors, one of them a draft: the published-author rule
    // (requirePublishedAuthor) is answered from primeLinks' one team_members read, so a
    // release's author checks cost one subrequest however many authors it names.
    const authors = [0, 1, 2, 3].map((k) => id(3000 + k));
    const DRAFT = authors[3]!;
    const posts: Row[] = [];
    const drafts: Row[] = [];
    for (let n = 0; n < 12; n += 1) {
      const postId = id(3100 + n);
      posts.push({
        id: postId,
        tenant_id: T,
        slug: `p${n}`,
        title: BI(`Post ${n}`, `مقال ${n}`),
        status: 'draft',
        author_id: null,
        version: 1,
      });
      drafts.push(
        draftRow({
          id: draftId(3100 + n),
          entity_type: 'blog_post',
          entity_id: postId,
          op: 'update',
          payload: { status: 'published', authorId: authors[n % 4] },
          base: { status: 'draft', author_id: null },
        }),
      );
    }
    const db = seed({
      blog_posts: posts,
      team_members: authors.map((member, k) => ({
        id: member,
        tenant_id: T,
        slug: `a${k}`,
        status: member === DRAFT ? 'draft' : 'published',
        version: 1,
      })),
      content_drafts: drafts,
    });
    const res = await run(VALIDATE, db, select(...drafts));
    expect(res.status).toBe(200);
    const items = res.data['items'] as Row[];
    expect(items).toHaveLength(12);
    for (const [n, item] of items.entries()) {
      const byDraft = drafts.findIndex((d) => d['id'] === item['draftId']);
      expect(byDraft, `item ${n}`).toBeGreaterThan(-1);
      expect(item['errors'], `post ${byDraft}`).toEqual(
        byDraft % 4 === 3
          ? [expect.objectContaining({ field: 'authorId', message: expect.any(String) })]
          : [],
      );
    }
    // One read of the authors: since Admin v2 R7, one entry of the batched read
    // (release_read_rows) rather than a request of its own; never one per author.
    const batched = db.calls
      .filter((c) => c.kind === 'rpc' && c.name === 'release_read_rows')
      .flatMap((c) => (c.values as { p_reads: { table: string }[] }).p_reads)
      .filter((read) => read.table === 'team_members');
    expect(db.calls.filter((c) => c.name === 'team_members')).toHaveLength(0);
    expect(batched).toHaveLength(1);
  });

  it('a release touching every registry type stays in a stated budget (the reads grow per table)', async () => {
    // One link-only change per type. Before Admin v2 R7, readLive cost one read per table and
    // primeLinks one per link table: 42 reads over the 22 types, and a clean all-types publish
    // about 51, past the Free plan's 50 (O-16). Since R7 each is ONE request for every table
    // (public.release_read_rows): the flag, the drafts, the live rows, the person, a team
    // member's account and the links, 6 (the rules do not run: these changes stop at the
    // Worker's own check; the clean publish below runs them). Held as a tripwire.
    const MAX_READS = 6;
    const tables: Record<string, Row[]> = {};
    const drafts: Row[] = [];
    let n = 0;
    for (const [type, entry] of Object.entries(RELEASE_REGISTRY)) {
      n += 1;
      const rowId = entry.key === 'tenant_id' ? T : id(2000 + n);
      (tables[entry.table] ??= []).push({
        id: id(2000 + n),
        tenant_id: T,
        version: 1,
        slug: `t${n}`,
        status: 'draft',
      });
      const payload: Row = {};
      const base: Row = {};
      for (const spec of RELEASE_LINKS[type as keyof typeof RELEASE_LINKS] ?? []) {
        base[spec.column] = null;
        // The seeded image and the publisher's own account; every other link a row of its own.
        if (spec.table === 'media_assets' || spec.table === 'profiles') {
          payload[spec.field] = spec.table === 'media_assets' ? POSTER : ADMIN;
          continue;
        }
        payload[spec.field] = id(2500 + n);
        (tables[spec.table] ??= []).push({
          id: id(2500 + n),
          tenant_id: T,
          version: 1,
          slug: `l${n}`,
          status: 'published',
        });
      }
      drafts.push(
        draftRow({
          id: draftId(2000 + n),
          entity_type: type,
          entity_id: rowId,
          op: 'update',
          payload,
          base,
        }),
      );
    }
    const db = seed({ ...tables, content_drafts: drafts });
    svc.answer = () => dryOk(drafts.length);
    const res = await run(VALIDATE, db, select(...drafts));
    expect(res.status).toBe(200);
    expect(drafts.length).toBeGreaterThanOrEqual(20);
    expect(db.calls.length + svc.calls.length).toBeLessThanOrEqual(MAX_READS);
  });
  it('O-16: a clean publish of one change of EVERY registry type, counted end to end, is under 50', async () => {
    // Admin v2 R7 brought the per-table reads into one request each (public.release_read_rows):
    // the live rows, then every link. This is a release that passes every check and publishes,
    // touching all 22 types at once, with every read the rules can make (a redirect's route
    // and chain, a hidden page's slug, the discipline warning, entity SEO's target, a team
    // member's account), the apply, and every after-effect (the slug read, both snapshots
    // rebuilt as the system, the purge's record and its line). Counted: every request of the
    // publisher's client and the service client, every log line as two (the tenant and the
    // insert), the snapshot rebuilds at their cost (the rules and their KV write: 2; the
    // visibility rows, the write, the rows again and the write again: 4), and the session's
    // two reads (getUser and the profile, in the middleware).
    const PAGE2 = id(3101);
    const TEAM = id(3102);
    const CATEGORY = id(3103);
    const SECTOR = id(3104);
    const CLIENT = id(3105);
    const STAT = id(3106);
    const CERT = id(3107);
    const CASE = id(3108);
    const QUOTE = id(3109);
    const POST = id(3110);
    const NAV = id(3111);
    const THEME = id(3112);
    const SEO = id(3113);
    const REDIRECT = id(3114);
    const VIS = id(3115);
    const FAQ = id(3116);
    const row = (rowId: string, over: Row = {}): Row => ({
      id: rowId,
      tenant_id: T,
      version: 1,
      status: 'draft',
      ...over,
    });
    const tables: Record<string, Row[]> = {
      categories: [{ id: CATEGORY, tenant_id: T, version: 1, slug: 'news' }],
      sectors: [row(SECTOR, { slug: 'retail' })],
      disciplines: [
        row(DISCIPLINE, { slug: 'branding', status: 'published', name: BI('Branding', 'هوية') }),
      ],
      clients: [row(CLIENT, { slug: 'acme' })],
      team_members: [row(TEAM, { slug: 'amal' })],
      statistics: [row(STAT, { slug: 'years' })],
      certifications: [row(CERT, { slug: 'iso' })],
      portfolio: [row(PROJECT, { slug: 'the-rider' })],
      service_cases: [row(CASE)],
      testimonials: [row(QUOTE, { slug: 'q1' })],
      blog_posts: [row(POST, { slug: 'hello' })],
      pages: [
        { id: PAGE, tenant_id: T, slug: 'about', status: 'published', version: 1 },
        { id: PAGE2, tenant_id: T, slug: 'join', status: 'published', version: 1 },
      ],
      navigation: [{ id: NAV, tenant_id: T, version: 1, sort_order: 1 }],
      site_profile: [{ tenant_id: T, version: 1, brand_name: null }],
      custom_themes: [{ id: THEME, tenant_id: T, version: 1, name: 'Old' }],
      seo_defaults: [{ tenant_id: T, version: 1, default_title: null }],
      page_visibility: [
        { id: VIS, tenant_id: T, page_id: PAGE2, template: null, mode: 'public', version: 1 },
      ],
      faq_items: [row(FAQ)],
    };
    const change = (
      n: number,
      type: string,
      entityId: string,
      payload: Row,
      base: Row,
      op: 'update' | 'create' = 'update',
    ) =>
      draftRow({
        id: draftId(3000 + n),
        entity_type: type,
        entity_id: entityId,
        op,
        payload,
        base,
        ...(op === 'create' ? { base_version: null } : {}),
      });
    const drafts = [
      change(1, 'category', CATEGORY, { name: BI('News', 'أخبار') }, { name: null }),
      change(2, 'sector', SECTOR, { name: BI('Retail', 'تجزئة') }, { name: null }),
      change(3, 'client', CLIENT, { logoMediaId: POSTER }, { logo_media_id: null }),
      change(
        4,
        'team_member',
        TEAM,
        { profileUserId: ADMIN, portraitMediaId: POSTER },
        { profile_user_id: null, portrait_media_id: null },
      ),
      change(5, 'statistic', STAT, { label: BI('Years', 'سنوات') }, { label: null }),
      change(6, 'certification', CERT, { name: BI('ISO', 'أيزو') }, { name: null }),
      change(7, 'discipline', DISCIPLINE, { posterMediaId: POSTER }, { poster_media_id: null }),
      change(
        8,
        'service',
        SERVICE,
        { disciplineId: DISCIPLINE, posterMediaId: POSTER },
        { discipline_id: DISCIPLINE, poster_media_id: null },
      ),
      change(
        9,
        'portfolio',
        PROJECT,
        { sectorId: SECTOR, clientId: CLIENT },
        { sector_id: null, client_id: null },
      ),
      change(
        10,
        'service_case',
        CASE,
        { serviceId: SERVICE, portfolioId: PROJECT },
        { service_id: null, portfolio_id: null },
      ),
      change(11, 'testimonial', QUOTE, { clientId: CLIENT }, { client_id: null }),
      change(
        12,
        'blog_post',
        POST,
        { authorId: TEAM, categoryId: CATEGORY },
        { author_id: null, category_id: null },
      ),
      change(13, 'page', PAGE, { title: BI('About us', 'من نحن') }, { title: null }),
      change(14, 'page_section', SECTION, { sortOrder: 2 }, { sort_order: 1 }),
      change(15, 'nav_item', NAV, { sortOrder: 2 }, { sort_order: 1 }),
      change(16, 'site_profile', T, { brandName: BI('Studio', 'استوديو') }, { brand_name: null }),
      change(17, 'custom_theme', THEME, { name: 'Calm' }, { name: 'Old' }),
      change(
        18,
        'entity_seo',
        SEO,
        {
          entityType: 'service',
          entityId: SERVICE,
          metaTitle: BI('Logo', 'شعار'),
          metaDescription: BI('Logo design', 'تصميم شعار'),
        },
        {},
        'create',
      ),
      change(
        19,
        'seo_defaults',
        T,
        { defaultTitle: BI('Studio', 'استوديو') },
        { default_title: null },
      ),
      change(
        20,
        'redirect',
        REDIRECT,
        { sourcePath: '/services/old-logo', targetPath: '/services' },
        {},
        'create',
      ),
      change(
        21,
        'page_visibility',
        VIS,
        { target: { pageId: PAGE2 }, mode: 'hidden', redirectPageId: null },
        { mode: 'public', redirect_page_id: null, hide_from: null, show_on: null },
      ),
      change(22, 'faq_item', FAQ, { question: BI('Why?', 'لماذا؟') }, { question: null }),
    ];
    expect(new Set(drafts.map((d) => d['entity_type'])).size).toBe(
      Object.keys(RELEASE_REGISTRY).length,
    );
    const db = seed({ ...tables, content_drafts: drafts });
    // The apply answers one item per change, with images that carry what the tags read.
    const items = drafts.map((d) =>
      applied(
        String(d['entity_type']),
        String(d['entity_id']),
        d['op'] as 'update' | 'create',
        d['op'] === 'create' ? null : { slug: 's', page_id: PAGE },
        { slug: 's', page_id: PAGE, entity_type: 'service', entity_id: SERVICE },
      ),
    );
    svc.answer = (fn) =>
      fn === 'record_release_purge' ? { data: null, error: null } : published(11, items);

    const res = await run(PUBLISH, db, select(...drafts));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(syncs).toMatchObject({ redirects: 1, visibility: 1 });

    const SESSION = 2;
    const SNAPSHOTS = 2 * syncs.redirects + 4 * syncs.visibility;
    const used = SESSION + db.calls.length + svc.calls.length + 2 * svc.logs.length + SNAPSHOTS;
    expect(used).toBeLessThanOrEqual(MAX_PUBLISH);
    expect(MAX_PUBLISH + PURGE_SET_UP).toBeLessThan(50);
  });
});
