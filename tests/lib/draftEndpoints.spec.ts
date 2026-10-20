import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import { CMS_ROLES, ROLES, type Role } from '@/lib/auth/types';
import { RELEASE_REGISTRY } from '@/lib/release/registry';
import {
  mayAuthor,
  mayRead,
  PENDING_ANY_CAP,
  PENDING_LIST_CAP,
  STAGE_ANY_CAP,
} from '@/lib/release/draftEndpoints';
import { PendingItemSchema, RELEASE_ENTITY_TYPES, type ReleaseEntityType } from '@schemas/release';
import { resetIds, T, type Db, type Row } from '../fixtures/stagedDb';
import {
  ADMIN,
  auditRowsOf,
  auditsOf,
  callRoute,
  draftRow,
  makeDb,
  OTHER_USER,
} from '../fixtures/stagedRoute';

// The draft endpoints (Admin v2 R3b), driven through their real routes over the PostgREST
// stand-in: the pending summary (filtered by each type's read capabilities, who can publish
// what, counts by area, names, no payload read), throwing one / mine / selected changes away
// (per-item capabilities, all or nothing, 409 listing what moved), and settling a conflict
// (keep mine, use the live version by payload key, an emptied change thrown away).

vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));

const pending = async () =>
  ((await import('@/pages/api/admin/releases/pending')) as { GET: APIRoute }).GET;
const discardOne = async () =>
  ((await import('@/pages/api/admin/drafts/[id]')) as { DELETE: APIRoute }).DELETE;
const discardBulk = async () =>
  ((await import('@/pages/api/admin/drafts/discard')) as { POST: APIRoute }).POST;
const resolve = async () =>
  ((await import('@/pages/api/admin/drafts/[id]/resolve')) as { POST: APIRoute }).POST;

const S1 = '33333333-3333-4333-8333-333333333301';
const SEO_ROW = '99999999-9999-4999-8999-000000000001';
const id = (n: number) => `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`;

const TITLE = { en: 'Logo', ar: 'شعار' };
const MINE = { en: 'Logos', ar: 'شعارات' };
const MOVED = { en: 'Logo design', ar: 'تصميم الشعار' };
const BLURB = { en: 'Marks that last' };

const service = (over: Row = {}): Row => ({
  id: S1,
  tenant_id: T,
  slug: 'logo',
  title: MOVED,
  short_title: null,
  blurb: null,
  body: null,
  body_html: null,
  hero_video_uid: null,
  category: null,
  status: 'draft',
  is_teaser: false,
  sort_order: 10,
  version: 5,
  discipline_id: null,
  intro: null,
  value_points: [],
  deliverables: [],
  poster_media_id: null,
  preview_video_path: null,
  preview_start_s: null,
  preview_end_s: null,
  ...over,
});

let db: Db;
beforeEach(() => {
  resetIds();
  db = makeDb({
    services: [service()],
    entity_seo: [],
    staff_directory: [
      { id: ADMIN, display_name: 'Amal', role: 'admin' },
      { id: OTHER_USER, display_name: 'Omar', role: 'content_creator' },
    ],
  });
});
const drafts = () => db.tables['content_drafts']!;

/** A service edit whose title live has moved under (base Logo, live Logo design). */
const serviceEdit = (over: Row = {}) =>
  draftRow({
    id: id(1),
    entity_type: 'service',
    entity_id: S1,
    payload: { title: MINE, blurb: BLURB },
    base: { title: TITLE, blurb: null },
    base_version: 4,
    fields: ['title', 'blurb'],
    label: { en: 'Logos' },
    ...over,
  });

// ── The gates ─────────────────────────────────────────────────────────────────────────────

describe('who the routes admit', () => {
  it('every CMS role passes the gates; each item is then checked on its own', () => {
    for (const role of CMS_ROLES) {
      expect(
        STAGE_ANY_CAP.some((cap) => mayAuthor(role, typeFor(cap))),
        role,
      ).toBe(true);
    }
    expect(PENDING_ANY_CAP.length).toBeGreaterThan(0);
  });

  it('Sales (C10a) authors nothing a release holds (P-2: never Sales)', () => {
    for (const type of RELEASE_ENTITY_TYPES) expect(mayAuthor('sales', type), type).toBe(false);
  });

  it('author rules are 0038’s: content by Admin and Content Creator, identity by Developer, SEO by SEO', () => {
    const by = (type: ReleaseEntityType) => ROLES.filter((role) => mayAuthor(role, type));
    expect(by('service')).toEqual(['admin', 'content_creator']);
    expect(by('site_profile')).toEqual(['admin', 'developer']);
    expect(by('entity_seo')).toEqual(['admin', 'seo']);
    expect(by('seo_defaults')).toEqual(['admin', 'seo']);
    expect(by('redirect')).toEqual(['admin', 'seo']);
    expect(by('custom_theme')).toEqual(['admin', 'developer']);
  });
});

/** Any type whose first author capability is this one (for the gate test). */
function typeFor(cap: string): ReleaseEntityType {
  return RELEASE_ENTITY_TYPES.find((t) => RELEASE_REGISTRY[t].authorCaps.includes(cap as never))!;
}

// ── GET /api/admin/releases/pending ───────────────────────────────────────────────────────

describe('the pending summary', () => {
  beforeEach(() => {
    db.tables['content_drafts'] = [
      serviceEdit({ updated_by: OTHER_USER, updated_at: '2026-10-18T09:00:00Z' }),
      draftRow({
        id: id(2),
        entity_type: 'service',
        entity_id: '33333333-3333-4333-8333-333333333302',
        payload: { status: 'archived' },
        fields: ['status'],
        updated_at: '2026-10-18T08:30:00Z',
      }),
      draftRow({
        id: id(3),
        entity_type: 'site_profile',
        payload: { brandName: MINE },
        fields: ['brand_name'],
        updated_at: '2026-10-18T08:20:00Z',
      }),
      draftRow({
        id: id(4),
        entity_type: 'entity_seo',
        entity_id: SEO_ROW,
        payload: { entityType: 'service', entityId: S1 },
        fields: ['meta_title'],
        release_id: '55555555-5555-4555-8555-555555555555',
        updated_at: '2026-10-18T08:10:00Z',
      }),
    ];
  });

  const read = async (role: Role, user = ADMIN) =>
    callRoute(db, await pending(), 'GET', '/api/admin/releases/pending', { role, user });

  it('lists only the types the caller may read', async () => {
    for (const role of CMS_ROLES) {
      const res = await read(role);
      expect(res.status).toBe(200);
      const types = (res.data['items'] as Row[]).map((i) => i['entityType'] as ReleaseEntityType);
      for (const type of types) expect(mayRead(role, RELEASE_REGISTRY[type]), role).toBe(true);
    }
    const typesOf = async (role: Role) =>
      ((await read(role)).data['items'] as Row[]).map((i) => i['entityType']);
    expect(await typesOf('admin')).toEqual(['service', 'service', 'site_profile', 'entity_seo']);
    expect(await typesOf('developer')).toEqual(['site_profile']);
    expect(await typesOf('seo')).toEqual(['service', 'service', 'entity_seo']);
    expect(await typesOf('content_creator')).toEqual(['service', 'service', 'entity_seo']);
    // Sales reads no area a release holds, so the summary's gate refuses it (C10a).
    expect((await read('sales')).status).toBe(403);
  });

  it('says who can publish each change, and what it waits for', async () => {
    const res = await read('content_creator', OTHER_USER);
    // Every item is the shape the savebar reads (packages/schemas/release.ts).
    for (const item of res.data['items'] as Row[])
      expect(PendingItemSchema.parse(item)).toBeTruthy();
    const [edit, archive, seo] = res.data['items'] as Row[];
    expect(edit).toMatchObject({
      draftId: id(1),
      draftVersion: 1,
      op: 'update',
      area: 'services',
      label: { en: 'Logos' },
      fields: ['title', 'blurb'],
      updatedBy: OTHER_USER,
      updatedByName: 'Omar',
      mine: true,
      scheduled: false,
      publishableByMe: true,
      requiredCaps: ['services.write', 'content.publish'],
      waitingFor: ['admin', 'content_creator'],
    });
    // An archive needs content.archiveDelete: it waits for an Admin.
    expect(archive).toMatchObject({
      publishableByMe: false,
      waitingFor: ['admin'],
      updatedByName: 'Amal',
      mine: false,
    });
    expect(seo).toMatchObject({
      scheduled: true,
      publishableByMe: false,
      waitingFor: ['admin', 'seo'],
    });
    expect(res.data['byArea']).toMatchObject({
      services: { total: 2, publishableByMe: 1, waiting: 1, mine: 1 },
      seo: { total: 1, publishableByMe: 0, waiting: 1, mine: 0 },
      settings: { total: 0, publishableByMe: 0, waiting: 0, mine: 0 },
    });
    expect([res.data['total'], res.data['truncated']]).toEqual([3, false]);
  });

  it('reads stored metadata only, for the caller’s tenant, names through the directory', async () => {
    await read('admin');
    const select = db.calls.find((c) => c.name === 'content_drafts')!.columns!;
    expect(select.split(',')).not.toContain('payload');
    expect(select.split(',')).not.toContain('base');
    expect(select).toContain('status:payload->>status');
    const directory = db.calls.find((c) => c.name === 'staff_directory')!;
    expect(directory.values).toEqual({ p_tenant: T });
  });

  it('without the directory the list still stands, unnamed', async () => {
    db.fail = (call) => (call.name === 'staff_directory' ? { code: '42501', message: 'no' } : null);
    const res = await read('admin');
    expect(res.status).toBe(200);
    expect((res.data['items'] as Row[])[0]!['updatedByName']).toBeNull();
  });

  it('lists at most 1,000 and says when there are more', async () => {
    db.tables['content_drafts'] = Array.from({ length: PENDING_LIST_CAP + 5 }, (_, n) =>
      draftRow({
        id: id(100 + n),
        entity_type: 'service',
        entity_id: `33333333-3333-4333-8333-${String(1000 + n).padStart(12, '0')}`,
      }),
    );
    const res = await read('admin');
    expect((res.data['items'] as Row[]).length).toBe(PENDING_LIST_CAP);
    expect(res.data['truncated']).toBe(true);
  });
});

// ── DELETE /api/admin/drafts/[id] ─────────────────────────────────────────────────────────

describe('throwing one change away', () => {
  beforeEach(() => {
    db.tables['content_drafts'] = [serviceEdit()];
  });
  const discard = async (version: string | null, role: Role = 'content_creator', draft = id(1)) =>
    callRoute(
      db,
      await discardOne(),
      'DELETE',
      `/api/admin/drafts/${draft}${version === null ? '' : `?version=${version}`}`,
      { role, params: { id: draft } },
    );

  it('at the version seen: gone, one writer call, audited by field names', async () => {
    const res = await discard('1');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.data).toEqual({ discarded: id(1), entityType: 'service', entityId: S1 });
    expect(drafts()).toEqual([]);
    expect(db.calls.filter((c) => c.name === 'write_drafts')).toHaveLength(1);
    expect(auditRowsOf(db)).toMatchObject([
      {
        action: 'service.draft_discard',
        entity_type: 'service',
        entity_id: S1,
        detail: { op: 'update', fields: ['title', 'blurb'] },
      },
    ]);
  });

  it('works with releases off (throwing away never changes the site)', async () => {
    db.flag = false;
    expect((await discard('1')).status).toBe(200);
    expect(db.calls.filter((c) => c.name === 'releases_enabled')).toEqual([]);
  });

  it('refuses a moved version (409), a claimed change (409 scheduled), no version (422)', async () => {
    expect([(await discard('2')).status, (await discard('2')).body['error']]).toEqual([
      409,
      'draft-conflict',
    ]);
    expect((await discard(null)).status).toBe(422);
    expect((await discard('x')).status).toBe(422);
    drafts()[0]!['release_id'] = '55555555-5555-4555-8555-555555555555';
    expect((await discard('1')).body['error']).toBe('scheduled');
    expect(drafts()).toHaveLength(1);
  });

  it('a type the caller may not stage is 403 naming the draft; nothing else is written', async () => {
    for (const role of ['seo', 'developer'] as const) {
      const res = await discard('1', role);
      expect(res.status, role).toBe(403);
      expect(res.body).toMatchObject({ capability: 'services.write', draftIds: [id(1)] });
    }
    expect(drafts()).toHaveLength(1);
    expect(auditsOf(db)).toEqual([]);
  });

  it('an unknown or malformed id is 404', async () => {
    expect((await discard('1', 'admin', id(9))).status).toBe(404);
    expect((await discard('1', 'admin', 'not-a-uuid')).status).toBe(404);
  });

  it('an entity-SEO change is audited under its target, as its save is', async () => {
    db.tables['content_drafts'] = [
      draftRow({
        id: id(5),
        entity_type: 'entity_seo',
        entity_id: SEO_ROW,
        op: 'create',
        payload: { entityType: 'service', entityId: S1 },
      }),
    ];
    const res = await discard('1', 'seo', id(5));
    expect(res.status).toBe(200);
    expect(auditRowsOf(db)[0]).toMatchObject({
      action: 'entity_seo.draft_discard',
      entity_id: S1,
      detail: { op: 'create', target: 'service' },
    });
  });

  it('the database refusing (a stale token) is a 403 and the change stays', async () => {
    db.fail = (call) => (call.name === 'write_drafts' ? { code: '42501', message: 'rls' } : null);
    expect((await discard('1')).status).toBe(403);
    expect(drafts()).toHaveLength(1);
  });
});

// ── POST /api/admin/drafts/discard ────────────────────────────────────────────────────────

describe('throwing several changes away', () => {
  const bulk = async (body: unknown, role: Role = 'content_creator', user = OTHER_USER) =>
    callRoute(db, await discardBulk(), 'POST', '/api/admin/drafts/discard', { body, role, user });

  beforeEach(() => {
    db.tables['content_drafts'] = [
      serviceEdit({ updated_by: OTHER_USER }),
      draftRow({ id: id(2), entity_type: 'service', entity_id: id(902), updated_by: OTHER_USER }),
      // Mine but claimed by a scheduled release: stays.
      draftRow({
        id: id(3),
        entity_type: 'service',
        entity_id: id(903),
        updated_by: OTHER_USER,
        release_id: '55555555-5555-4555-8555-555555555555',
      }),
      // Someone else's.
      draftRow({ id: id(4), entity_type: 'service', entity_id: id(904), updated_by: ADMIN }),
      // Mine, but of a type I may not stage (I was a Developer when I saved it).
      draftRow({ id: id(5), entity_type: 'site_profile', updated_by: OTHER_USER }),
    ];
  });

  it('mine: my unclaimed changes of types I may stage, one call, one audit row', async () => {
    const res = await bulk({ scope: 'mine' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.data).toEqual({ discarded: 2, more: false });
    expect(drafts().map((d) => d['id'])).toEqual([id(3), id(4), id(5)]);
    expect(db.calls.filter((c) => c.name === 'write_drafts')).toHaveLength(1);
    expect(auditRowsOf(db)).toMatchObject([
      {
        action: 'drafts.discard_bulk',
        detail: { count: 2, scope: 'mine', types: ['service'], draftIds: [id(1), id(2)] },
      },
    ]);
  });

  it('mine with nothing to throw away writes nothing', async () => {
    const res = await bulk({ scope: 'mine' }, 'seo', '44444444-4444-4444-8444-444444444444');
    expect(res.data).toEqual({ discarded: 0, more: false });
    expect(db.calls.filter((c) => c.name === 'write_drafts')).toEqual([]);
    expect(auditsOf(db)).toEqual([]);
  });

  it('mine: at most 200 a request, `more` when others remain', async () => {
    db.tables['content_drafts'] = Array.from({ length: 205 }, (_, n) =>
      draftRow({
        id: id(100 + n),
        entity_type: 'service',
        entity_id: id(2000 + n),
        updated_by: OTHER_USER,
      }),
    );
    const res = await bulk({ scope: 'mine' });
    expect(res.data).toEqual({ discarded: 200, more: true });
    expect(drafts()).toHaveLength(5);
  });

  it('selected: all at the versions seen, or none', async () => {
    const res = await bulk({
      items: [
        { draftId: id(1), draftVersion: 1 },
        { draftId: id(4), draftVersion: 1 },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(drafts().map((d) => d['id'])).toEqual([id(2), id(3), id(5)]);
    expect(auditRowsOf(db)[0]!['detail']).toMatchObject({ scope: 'selected', count: 2 });
  });

  it('selected: one I may not stage is 403 naming it; nothing is thrown away', async () => {
    const res = await bulk({
      items: [
        { draftId: id(1), draftVersion: 1 },
        { draftId: id(5), draftVersion: 1 },
      ],
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ draftIds: [id(5)], capability: 'settings.general' });
    expect(drafts()).toHaveLength(5);
  });

  it('selected: moved, claimed or missing ones are 409 pending-changed listing them', async () => {
    const res = await bulk({
      items: [
        { draftId: id(1), draftVersion: 1 },
        { draftId: id(2), draftVersion: 7 },
        { draftId: id(3), draftVersion: 1 },
        { draftId: id(99), draftVersion: 1 },
      ],
    });
    expect([res.status, res.body['error']]).toEqual([409, 'pending-changed']);
    expect(res.body['draftIds']).toEqual([id(2), id(3), id(99)]);
    expect(drafts()).toHaveLength(5);
    expect(auditsOf(db)).toEqual([]);
  });

  it('selected: one moving between the read and the write is 409 and nothing is lost', async () => {
    db.fail = (call) => {
      if (call.name === 'write_drafts') drafts()[1]!['version'] = 2;
      return null;
    };
    const res = await bulk({
      items: [
        { draftId: id(1), draftVersion: 1 },
        { draftId: id(2), draftVersion: 1 },
      ],
    });
    expect([res.status, res.body['error']]).toEqual([409, 'pending-changed']);
    expect(drafts()).toHaveLength(5);
  });

  it('refuses a malformed body: both shapes at once, a repeat, more than 200', async () => {
    const one = { draftId: id(1), draftVersion: 1 };
    for (const body of [
      { scope: 'all' },
      { scope: 'mine', items: [one] },
      { items: [one, one] },
      { items: [] },
      { items: Array.from({ length: 201 }, (_, n) => ({ draftId: id(n), draftVersion: 1 })) },
    ]) {
      expect((await bulk(body)).status, JSON.stringify(body).slice(0, 60)).toBe(422);
    }
  });
});

// ── POST /api/admin/drafts/[id]/resolve ───────────────────────────────────────────────────

describe('settling a conflict', () => {
  beforeEach(() => {
    db.tables['content_drafts'] = [serviceEdit()];
  });
  const settle = async (body: Row, role: Role = 'content_creator', draft = id(1)) =>
    callRoute(db, await resolve(), 'POST', `/api/admin/drafts/${draft}/resolve`, {
      body,
      role,
      params: { id: draft },
    });

  it('keep mine: the base takes what live holds now; the change itself stays', async () => {
    const res = await settle({ version: 1, keepMine: ['title'] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(drafts()[0]).toMatchObject({
      version: 2,
      payload: { title: MINE, blurb: BLURB },
      base: { title: MOVED, blurb: null },
    });
    expect(res.data).toMatchObject({ title: MINE, version: 5 });
    expect((res.data['draft'] as Row)['conflict']).toBeUndefined();
    expect(auditRowsOf(db)).toMatchObject([
      { action: 'service.draft_resolve', detail: { keepMine: ['title'], useLive: [] } },
    ]);
  });

  it('use the live version: the payload key and its base leave the change', async () => {
    const res = await settle({ version: 1, useLive: ['title'] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(drafts()[0]).toMatchObject({ payload: { blurb: BLURB }, base: { blurb: null } });
    expect(drafts()[0]!['fields']).toEqual(['blurb']);
    expect(res.data['title']).toEqual(MOVED);
  });

  it('a key is dropped whole, with every column it writes (body and its HTML)', async () => {
    const doc = { en: { type: 'doc', content: [] } };
    drafts()[0] = serviceEdit({
      payload: { title: MINE, body: doc },
      base: { title: TITLE, body: null, body_html: null },
    });
    const res = await settle({ version: 1, useLive: ['body'] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(drafts()[0]).toMatchObject({ payload: { title: MINE }, base: { title: TITLE } });
  });

  it('a change left writing nothing is thrown away', async () => {
    drafts()[0] = serviceEdit({ payload: { title: MINE }, base: { title: TITLE } });
    const res = await settle({ version: 1, useLive: ['title'] });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ resolved: id(1), draft: null });
    expect(drafts()).toEqual([]);
    expect(auditRowsOf(db)[0]).toMatchObject({
      action: 'service.draft_resolve',
      detail: { useLive: ['title'], discarded: true },
    });
  });

  it('refuses a column the change does not write (422), and one named twice (422)', async () => {
    expect((await settle({ version: 1, keepMine: ['slug'] })).status).toBe(422);
    expect((await settle({ version: 1, keepMine: ['title'], useLive: ['title'] })).status).toBe(
      422,
    );
    expect((await settle({ version: 1 })).status).toBe(422);
    expect(drafts()[0]!['version']).toBe(1);
  });

  it('a moved version 409, a claimed change 409 scheduled, the row gone 409', async () => {
    expect((await settle({ version: 2, keepMine: ['title'] })).body['error']).toBe(
      'draft-conflict',
    );
    drafts()[0]!['release_id'] = '55555555-5555-4555-8555-555555555555';
    expect((await settle({ version: 1, keepMine: ['title'] })).body['error']).toBe('scheduled');
    drafts()[0]!['release_id'] = null;
    db.tables['services'] = [];
    const gone = await settle({ version: 1, keepMine: ['title'] });
    expect([gone.status, gone.body['error']]).toEqual([409, 'draft-conflict']);
    expect(gone.body['detail']).toBe('This item was removed on the live site. Discard the change.');
  });

  it('a pending create has nothing to settle (422); releases off can only discard (422)', async () => {
    drafts()[0] = serviceEdit({ op: 'create', base: {}, base_version: null });
    expect((await settle({ version: 1, keepMine: ['title'] })).status).toBe(422);
    drafts()[0] = serviceEdit();
    db.flag = false;
    const off = await settle({ version: 1, keepMine: ['title'] });
    expect(off.status).toBe(422);
    expect(drafts()[0]!['version']).toBe(1);
  });

  it('per item: SEO may not settle a service change; only an Admin settles an archive', async () => {
    expect((await settle({ version: 1, keepMine: ['title'] }, 'seo')).status).toBe(403);
    drafts()[0] = serviceEdit({
      payload: { title: MINE, status: 'archived' },
      base: { title: TITLE, status: 'draft' },
    });
    const cc = await settle({ version: 1, keepMine: ['title'] });
    expect(cc.status).toBe(403);
    expect(cc.body['capability']).toBe('content.archiveDelete');
    expect((await settle({ version: 1, keepMine: ['title'] }, 'admin')).status).toBe(200);
  });

  it('entity SEO, a full replace: "use live" takes the live value, keeping the payload whole', async () => {
    db.tables['entity_seo'] = [
      {
        id: SEO_ROW,
        tenant_id: T,
        entity_type: 'service',
        entity_id: S1,
        meta_title: MOVED,
        meta_description: TITLE,
        og_image: null,
        og_media_id: null,
        canonical_override: null,
        robots: null,
        schema_type: null,
        version: 3,
      },
    ];
    db.tables['content_drafts'] = [
      draftRow({
        id: id(6),
        entity_type: 'entity_seo',
        entity_id: SEO_ROW,
        payload: {
          entityType: 'service',
          entityId: S1,
          metaTitle: MINE,
          metaDescription: MINE,
        },
        base: {
          meta_title: TITLE,
          meta_description: TITLE,
          og_image: null,
          og_media_id: null,
          canonical_override: null,
          robots: null,
          schema_type: null,
        },
      }),
    ];
    const res = await settle({ version: 1, useLive: ['meta_title'] }, 'seo', id(6));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(drafts()[0]).toMatchObject({
      payload: { entityType: 'service', entityId: S1, metaTitle: MOVED, metaDescription: MINE },
    });
    expect((drafts()[0]!['base'] as Row)['meta_title']).toEqual(MOVED);
    // The pending list names only what still differs from live.
    expect(drafts()[0]!['fields']).toEqual(['meta_description']);
    expect(auditRowsOf(db)[0]).toMatchObject({
      action: 'entity_seo.draft_resolve',
      entity_id: S1,
      detail: { target: 'service' },
    });
  });

  it('page visibility (a full replace with derived dates): use live is refused in words', async () => {
    db.tables['page_visibility'] = [
      { id: SEO_ROW, tenant_id: T, page_id: S1, template: null, mode: 'public', version: 2 },
    ];
    db.tables['content_drafts'] = [
      draftRow({
        id: id(7),
        entity_type: 'page_visibility',
        entity_id: SEO_ROW,
        payload: { target: { pageId: S1 }, mode: 'hidden' },
        base: { mode: 'link' },
      }),
    ];
    const res = await settle({ version: 1, useLive: ['mode'] }, 'developer', id(7));
    expect([res.status, res.body['field']]).toEqual([422, 'useLive']);
    expect(drafts()[0]!['version']).toBe(1);
  });
});
