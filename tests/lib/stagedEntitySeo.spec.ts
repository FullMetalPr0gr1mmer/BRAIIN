import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import { resetIds, T, type Db, type Row } from '../fixtures/stagedDb';
import {
  auditRowsOf,
  auditsOf,
  callRoute,
  draftRow,
  liveWritesOf,
  makeDb,
} from '../fixtures/stagedRoute';

// The staged branch of /api/admin/entity-seo (Admin v2 R3b), through the real route over the
// PostgREST stand-in. Releases on: the GET finds the target's pending change (by the SEO row's
// id, or with no row the pending create naming the target), the PUT stages a full replace that
// always stores the target, a second create for one target is a conflict, and the Arabic meta
// is still required. Nothing live is written.

vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));

type Routes = { GET: APIRoute; PUT: APIRoute };
const routes = async () => (await import('@/pages/api/admin/entity-seo')) as Routes;

const SERVICE = '33333333-3333-4333-8333-333333333301';
const SEO_ROW = '99999999-9999-4999-8999-000000000001';
const TITLE = { en: 'Logo design', ar: 'تصميم الشعار' };
const DESC = { en: 'Logos that last', ar: 'شعارات تدوم' };
const NEW_TITLE = { en: 'Logo design studio', ar: 'استوديو تصميم الشعار' };

const seoRow = (over: Row = {}): Row => ({
  id: SEO_ROW,
  tenant_id: T,
  entity_type: 'service',
  entity_id: SERVICE,
  meta_title: TITLE,
  meta_description: DESC,
  og_image: null,
  canonical_override: null,
  robots: null,
  schema_type: null,
  version: 2,
  updated_at: '2026-10-01T00:00:00Z',
  ...over,
});

const save = (over: Row = {}): Row => ({
  entityType: 'service',
  entityId: SERVICE,
  metaTitle: NEW_TITLE,
  metaDescription: DESC,
  ...over,
});

const QUERY = `/api/admin/entity-seo?entityType=service&entityId=${SERVICE}`;

let db: Db;
beforeEach(() => {
  resetIds();
  db = makeDb({ entity_seo: [] });
});
const drafts = () => db.tables['content_drafts']!;
const ref = (d: Row) => ({ draftId: d['id'], draftVersion: d['version'] });

describe('GET with releases on, by target', () => {
  it('no row, no change: the defaults for the target, and no pending change', async () => {
    const res = await callRoute(db, (await routes()).GET, 'GET', QUERY, { role: 'seo' });
    expect(res.data).toMatchObject({
      id: null,
      entity_type: 'service',
      entity_id: SERVICE,
      version: 0,
      draft: null,
    });
  });

  it('a row with a pending edit: the edit over live, found by the row’s id', async () => {
    db.tables['entity_seo'] = [seoRow()];
    db.tables['content_drafts'] = [
      draftRow({
        entity_type: 'entity_seo',
        entity_id: SEO_ROW,
        payload: save(),
        base: { meta_title: TITLE },
      }),
    ];
    const res = await callRoute(db, (await routes()).GET, 'GET', QUERY, {
      role: 'content_creator',
    });
    expect(res.data).toMatchObject({ id: SEO_ROW, meta_title: NEW_TITLE, version: 2 });
    expect((res.data['draft'] as Row)['op']).toBe('update');
  });

  it('no row, a pending create naming the target: found by its target', async () => {
    db.tables['content_drafts'] = [
      draftRow({
        entity_type: 'entity_seo',
        entity_id: SEO_ROW,
        op: 'create',
        base_version: null,
        payload: save(),
      }),
      // Another target's pending create is not this one's.
      draftRow({
        id: '77777777-7777-4777-8777-000000000002',
        entity_type: 'entity_seo',
        entity_id: '99999999-9999-4999-8999-000000000002',
        op: 'create',
        base_version: null,
        payload: save({ entityId: '33333333-3333-4333-8333-333333333302', metaTitle: TITLE }),
      }),
    ];
    const res = await callRoute(db, (await routes()).GET, 'GET', QUERY);
    expect(res.data).toMatchObject({
      id: SEO_ROW,
      entity_type: 'service',
      entity_id: SERVICE,
      meta_title: NEW_TITLE,
      version: 0,
    });
    expect((res.data['draft'] as Row)['op']).toBe('create');
  });
});

describe('PUT with releases on', () => {
  it('no row: a pending create under a Worker id, storing the target; nothing live', async () => {
    const res = await callRoute(db, (await routes()).PUT, 'PUT', '/api/admin/entity-seo', {
      body: { ...save(), id: SEO_ROW, version: 0 },
      role: 'seo',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(liveWritesOf(db, 'entity_seo')).toEqual([]);
    const [d] = drafts();
    expect(d).toMatchObject({ entity_type: 'entity_seo', op: 'create', base: {} });
    expect(d!['entity_id']).not.toBe(SEO_ROW); // never the client's
    expect(d!['payload']).toMatchObject({ entityType: 'service', entityId: SERVICE });
    expect(res.data).toMatchObject({ entity_id: SERVICE, meta_title: NEW_TITLE, version: 0 });
    expect(auditRowsOf(db)).toMatchObject([
      {
        action: 'entity_seo.draft_save',
        entity_id: SERVICE,
        detail: { op: 'create', target: 'service' },
      },
    ]);
  });

  it('a second create for the same target conflicts, a named one edits it', async () => {
    const { PUT } = await routes();
    await callRoute(db, PUT, 'PUT', '/api/admin/entity-seo', { body: { ...save(), version: 0 } });
    const blind = await callRoute(db, PUT, 'PUT', '/api/admin/entity-seo', {
      body: { ...save({ robots: 'noindex' }), version: 0 },
    });
    expect([blind.status, blind.body['error']]).toEqual([409, 'draft-conflict']);
    const named = await callRoute(db, PUT, 'PUT', '/api/admin/entity-seo', {
      body: { ...save({ robots: 'noindex' }), ...ref(drafts()[0]!) },
    });
    expect(named.status, JSON.stringify(named.body)).toBe(200);
    expect(drafts()).toHaveLength(1);
    expect(drafts()[0]).toMatchObject({ op: 'create', version: 2 });
    expect((drafts()[0]!['payload'] as Row)['robots']).toBe('noindex');
  });

  it('the database refuses a second pending create for one target (a race)', async () => {
    // Someone else stages the target's create between the Worker's lookup and its write: the
    // writer (0038's one-per-target index, emulated) refuses, and the save is a 409.
    db.fail = (call) => {
      if (call.name === 'write_drafts' && drafts().length === 0) {
        drafts().push(
          draftRow({
            entity_type: 'entity_seo',
            entity_id: SEO_ROW,
            op: 'create',
            base_version: null,
            payload: save(),
          }),
        );
      }
      return null;
    };
    const res = await callRoute(db, (await routes()).PUT, 'PUT', '/api/admin/entity-seo', {
      body: { ...save({ robots: 'noindex' }), version: 0 },
    });
    expect([res.status, res.body['error']]).toEqual([409, 'draft-conflict']);
    expect(drafts()).toHaveLength(1);
    expect(auditsOf(db)).toEqual([]);
  });

  it('a row: a full replace over it, the target kept, a base for every column it writes', async () => {
    db.tables['entity_seo'] = [seoRow()];
    const res = await callRoute(db, (await routes()).PUT, 'PUT', '/api/admin/entity-seo', {
      body: { ...save(), version: 2 },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [d] = drafts();
    expect(d).toMatchObject({ entity_id: SEO_ROW, op: 'update', base_version: 2 });
    expect(d!['payload']).toMatchObject({ entityType: 'service', entityId: SERVICE });
    expect(d!['base']).toEqual({
      meta_title: TITLE,
      meta_description: DESC,
      og_image: null,
      canonical_override: null,
      robots: null,
      schema_type: null,
    });
    // The pending list names only what differs from live.
    expect(d!['fields']).toEqual(['meta_title']);
    expect(res.data).toMatchObject({ id: SEO_ROW, meta_title: NEW_TITLE, version: 2 });
    expect(liveWritesOf(db, 'entity_seo')).toEqual([]);
  });

  it('a stale version is 409; a save equal to live stages nothing', async () => {
    db.tables['entity_seo'] = [seoRow()];
    const { PUT } = await routes();
    const stale = await callRoute(db, PUT, 'PUT', '/api/admin/entity-seo', {
      body: { ...save(), version: 1 },
    });
    expect([stale.status, stale.body['error']]).toEqual([409, 'conflict']);
    const same = await callRoute(db, PUT, 'PUT', '/api/admin/entity-seo', {
      body: { ...save({ metaTitle: TITLE }), version: 2 },
    });
    expect(same.status).toBe(200);
    expect(same.data['draft']).toBeNull();
    expect(drafts()).toEqual([]);
  });

  it('setting a pending edit back to live throws it away', async () => {
    db.tables['entity_seo'] = [seoRow()];
    const { PUT } = await routes();
    await callRoute(db, PUT, 'PUT', '/api/admin/entity-seo', { body: { ...save(), version: 2 } });
    const back = await callRoute(db, PUT, 'PUT', '/api/admin/entity-seo', {
      body: { ...save({ metaTitle: TITLE }), ...ref(drafts()[0]!) },
    });
    expect(back.status).toBe(200);
    expect(drafts()).toEqual([]);
    expect(auditsOf(db)).toEqual(['entity_seo.draft_save', 'entity_seo.draft_discard']);
  });

  it('the Arabic meta is still required, and a Content Creator still cannot write', async () => {
    const { PUT } = await routes();
    const noArabic = await callRoute(db, PUT, 'PUT', '/api/admin/entity-seo', {
      body: { ...save({ metaTitle: { en: 'Only English', ar: '' } }), version: 0 },
    });
    expect(noArabic.status).toBe(422);
    const cc = await callRoute(db, PUT, 'PUT', '/api/admin/entity-seo', {
      body: { ...save(), version: 0 },
      role: 'content_creator',
    });
    expect(cc.status).toBe(403);
    expect(drafts()).toEqual([]);
  });

  it('a pending change named by a form that has gone: published or discarded, with live', async () => {
    db.tables['entity_seo'] = [seoRow()];
    const gone = '88888888-8888-4888-8888-000000000001';
    db.tables['content_release_items'] = [{ id: 1, tenant_id: T, draft_id: gone }];
    const res = await callRoute(db, (await routes()).PUT, 'PUT', '/api/admin/entity-seo', {
      body: { ...save(), draftId: gone, draftVersion: 3 },
    });
    expect([res.status, res.body['error']]).toEqual([409, 'draft-published']);
    expect((res.body['live'] as Row)['meta_title']).toEqual(TITLE);
  });

  it('with releases off nothing is staged: the row is written as before', async () => {
    db.flag = false;
    db.tables['entity_seo'] = [seoRow()];
    const res = await callRoute(db, (await routes()).PUT, 'PUT', '/api/admin/entity-seo', {
      body: { ...save(), version: 2 },
    });
    expect(res.status).toBe(200);
    expect(liveWritesOf(db, 'entity_seo')).toHaveLength(1);
    expect(drafts()).toEqual([]);
    expect(auditsOf(db)).toEqual(['entity_seo.update']);
  });
});
