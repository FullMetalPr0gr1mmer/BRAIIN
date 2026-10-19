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
    rpc: async (fn: string, args: Record<string, unknown>) => {
      svc.calls.push({ fn, args });
      return svc.answer(fn, args);
    },
  }),
}));
vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async (entry: Record<string, unknown>) => {
    svc.logs.push(entry);
    return true;
  },
}));
const syncs = vi.hoisted(() => ({ redirects: 0, visibility: 0 }));
vi.mock('@/lib/admin/redirectSync', () => ({
  syncRedirectsToEdge: async () => {
    syncs.redirects += 1;
    return { kvSynced: true, count: 1, truncated: false };
  },
}));
vi.mock('@/lib/admin/visibilitySync', () => ({
  syncVisibilityToEdge: async () => {
    syncs.visibility += 1;
    return { kvSynced: false, count: 0 };
  },
}));

const { POST: PUBLISH } = await import('@/pages/api/admin/releases/index');
const { POST: VALIDATE } = await import('@/pages/api/admin/releases/validate');

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

const published = (number = 7) => ({
  data: { release_id: id(99), number, items: [] },
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
  it('a clean release: applied as the publisher, the purge a logged no-op, nothing fatal after', async () => {
    const draft = serviceEdit(
      { title: BI('Logo', 'شعار') },
      { title: BI('Logo Design', 'تصميم الشعار') },
    );
    const res = await run(PUBLISH, seed({ content_drafts: [draft] }), {
      ...select(draft),
      note: 'Spring copy',
    });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      release: { id: id(99), number: 7 },
      items: [{ entityType: 'service', entityId: SERVICE, op: 'update' }],
      purge: 'skipped',
    });
    expect(applyCalls()[0]!.args).toMatchObject({ p_mode: 'publish', p_note: 'Spring copy' });
    const purge = svc.calls.find((c) => c.fn === 'record_release_purge');
    expect(purge!.args).toMatchObject({ p_tenant: T, p_release: id(99), p_status: 'skipped' });
    expect(svc.logs).toContainEqual(
      expect.objectContaining({ level: 'info', source: 'release:purge' }),
    );
    expect(syncs).toEqual({ redirects: 0, visibility: 0 });
  });

  it('a release with a redirect rebuilds the edge map; a failed purge record is only logged', async () => {
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
        : published(8);
    const res = await run(PUBLISH, seed({ content_drafts: [redirect] }), select(redirect), 'seo');
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ release: { number: 8 }, kvSynced: true, purge: 'skipped' });
    expect(syncs.redirects).toBe(1);
    expect(svc.logs).toContainEqual(
      expect.objectContaining({ level: 'error', source: 'release:purge' }),
    );
  });

  it('a page change by a Content Creator never rebuilds the visibility snapshot', async () => {
    // Built from what the publisher's client reads: Content Creator reads no page_visibility,
    // so a rebuild would write an EMPTY snapshot and make every hidden page public.
    const draft = draftRow({
      id: draftId(13),
      entity_type: 'page',
      entity_id: PAGE,
      op: 'update',
      payload: { title: BI('About us', 'من نحن') },
      base: { title: BI('About', 'عنا') },
    });
    const res = await run(
      PUBLISH,
      seed({ content_drafts: [draft] }),
      select(draft),
      'content_creator',
    );
    expect(res.status).toBe(200);
    expect(syncs.visibility).toBe(0);
    expect(res.data['kvSynced']).toBeUndefined();
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
    const res = await run(PUBLISH, db, select(draft), 'developer');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(syncs.visibility).toBe(1);
    expect(res.data['kvSynced']).toBe(false);
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
});
