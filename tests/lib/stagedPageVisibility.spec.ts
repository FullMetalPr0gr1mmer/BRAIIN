import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import { resetIds, T, type Db, type Row } from '../fixtures/stagedDb';
import { auditsOf, callRoute, draftRow, liveWritesOf, makeDb } from '../fixtures/stagedRoute';
import {
  HOME_REFUSAL,
  RELEASE_NOTE_KEPT,
  RELEASE_PASSWORD_ONLY,
  RELEASE_PASSWORD_PENDING,
} from '@/lib/admin/visibilityCopy';

// Page visibility in release mode (Admin v2 R14b), through the real routes over the PostgREST
// stand-in. `page_visibility` is a registry table guarded by 0066, so with releases on its
// routes must stage: the list shows each setting's pending change, a save is a pending change
// (a full replace keyed by its target), nothing live is written, synced or purged, and the
// password door stays immediate only where 0066's guard lets it (a page already asking for
// one, its message unchanged, nothing pending). Releases off, every route is what it was.

vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));
vi.mock('@/lib/admin/liveRecheck', () => ({ liveRecheck: async () => undefined }));
const { edge } = vi.hoisted(() => ({ edge: { syncs: 0, purges: 0 } }));
vi.mock('@/lib/admin/visibilitySync', async (original) => ({
  ...(await original<typeof import('@/lib/admin/visibilitySync')>()),
  edgeVisibilityStatus: async () => null,
  syncVisibilityToEdge: async () => {
    edge.syncs += 1;
    return { kvSynced: true };
  },
}));
vi.mock('@/lib/http/purge', async (original) => ({
  ...(await original<typeof import('@/lib/http/purge')>()),
  purgeAfterSave: async () => {
    edge.purges += 1;
  },
}));

type Screen = { GET: APIRoute; PUT: APIRoute };
const screen = async () => (await import('@/pages/api/admin/page-visibility/index')) as Screen;
const password = async () =>
  (await import('@/pages/api/admin/page-visibility/password')) as { POST: APIRoute };
const alias = async () =>
  (await import('@/pages/api/admin/pages/visibility/[id]')) as { PATCH: APIRoute };

const HOME = '22222222-2222-4222-8222-000000000001';
const ABOUT = '22222222-2222-4222-8222-000000000002';
const CONTACT = '22222222-2222-4222-8222-000000000003';
const ABOUT_ROW = '99999999-9999-4999-8999-0000000000a1';
const API = '/api/admin/page-visibility';

const page = (id: string, slug: string): Row => ({
  id,
  tenant_id: T,
  slug,
  title: { en: slug },
  status: 'published',
});

const aboutRow = (over: Row = {}): Row => ({
  id: ABOUT_ROW,
  tenant_id: T,
  page_id: ABOUT,
  template: null,
  mode: 'hidden',
  redirect_page_id: null,
  // PostgREST's spelling of a timestamptz: the Riyadh midnight of 2 November.
  hide_from: '2026-11-01T21:00:00+00:00',
  show_on: null,
  note: null,
  password_version: 0,
  version: 3,
  updated_at: '2026-10-30T08:00:00Z',
  ...over,
});

const body = (over: Row = {}): Row => ({
  target: { pageId: ABOUT },
  mode: 'hidden',
  redirectPageId: null,
  hideFrom: null,
  showOn: null,
  version: 0,
  ...over,
});

let db: Db;
beforeEach(() => {
  resetIds();
  edge.syncs = 0;
  edge.purges = 0;
  db = makeDb({
    pages: [page(HOME, 'home'), page(ABOUT, 'about'), page(CONTACT, 'contact')],
    page_visibility: [],
    services: [],
    portfolio: [],
  });
});
const drafts = () => db.tables['content_drafts']!;
const rpcs = (name: string) => db.calls.filter((c) => c.kind === 'rpc' && c.name === name);

describe('GET with releases on: each setting with its pending change', () => {
  it('live stays live; the pending change is beside it, an edit by row id and a create by target', async () => {
    db.tables['page_visibility'] = [aboutRow()];
    db.tables['content_drafts'] = [
      draftRow({
        entity_type: 'page_visibility',
        entity_id: ABOUT_ROW,
        payload: body({ mode: 'link' }),
        base: { mode: 'hidden' },
        base_version: 3,
        fields: ['mode'],
      }),
      draftRow({
        id: '77777777-7777-4777-8777-000000000002',
        entity_type: 'page_visibility',
        entity_id: '99999999-9999-4999-8999-0000000000c1',
        op: 'create',
        base_version: null,
        payload: body({ target: { pageId: CONTACT }, mode: 'hidden' }),
      }),
    ];
    const res = await callRoute(db, (await screen()).GET, 'GET', API, { role: 'developer' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.data['draftsInvalid']).toEqual([]);
    const pages = res.data['pages'] as Row[];
    const about = pages.find((p) => p['id'] === ABOUT)!;
    expect(about['setting']).toMatchObject({ mode: 'hidden', hideFrom: '2026-11-02', version: 3 });
    expect(about['pending']).toMatchObject({
      draftId: '77777777-7777-4777-8777-000000000001',
      draftVersion: 1,
      op: 'update',
      scheduled: false,
      conflict: [],
      setting: { mode: 'link', hideFrom: null },
    });
    const contact = pages.find((p) => p['id'] === CONTACT)!;
    expect(contact['setting']).toBeNull();
    expect(contact['pending']).toMatchObject({ op: 'create', setting: { mode: 'hidden' } });
    expect(pages.find((p) => p['id'] === HOME)!['pending']).toBeNull();
    expect((res.data['templates'] as Row[]).every((t) => t['pending'] === null)).toBe(true);
  });

  it('releases off: the answer is main’s, no pending key and no release mark', async () => {
    db.flag = false;
    db.tables['page_visibility'] = [aboutRow()];
    const res = await callRoute(db, (await screen()).GET, 'GET', API);
    expect(res.status).toBe(200);
    expect('draftsInvalid' in res.data).toBe(false);
    for (const item of [...(res.data['pages'] as Row[]), ...(res.data['templates'] as Row[])]) {
      expect('pending' in item).toBe(false);
    }
  });
});

describe('PUT with releases on: a pending change, nothing live', () => {
  it('no row: a pending create under a Worker id, storing the target; audited; nothing synced', async () => {
    const res = await callRoute(db, (await screen()).PUT, 'PUT', API, {
      body: { ...body({ hideFrom: '2026-11-02' }), staged: true },
      role: 'developer',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(liveWritesOf(db, 'page_visibility')).toEqual([]);
    const [d] = drafts();
    expect(d).toMatchObject({ entity_type: 'page_visibility', op: 'create', base: {} });
    expect(d!['payload']).toMatchObject({ target: { pageId: ABOUT }, mode: 'hidden' });
    expect(res.data).toMatchObject({
      setting: null,
      staged: true,
      kvSynced: true,
      pending: { op: 'create', setting: { mode: 'hidden', hideFrom: '2026-11-02' } },
    });
    expect(auditsOf(db)).toEqual(['page_visibility.draft_save']);
    expect(edge).toEqual({ syncs: 0, purges: 0 });
  });

  it('no row and "visible to everyone": nothing to stage', async () => {
    const res = await callRoute(db, (await screen()).PUT, 'PUT', API, {
      body: body({ mode: 'public' }),
    });
    expect(res.status).toBe(200);
    expect(drafts()).toEqual([]);
    expect(res.data).toMatchObject({ setting: null, pending: null, staged: true });
  });

  it('an edit equal to live (the same Riyadh day, spelled otherwise) stages nothing', async () => {
    db.tables['page_visibility'] = [aboutRow()];
    const res = await callRoute(db, (await screen()).PUT, 'PUT', API, {
      body: body({ hideFrom: '2026-11-02', version: 3 }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(drafts()).toEqual([]);
    expect(liveWritesOf(db, 'page_visibility')).toEqual([]);
  });

  it('an edit of a live row: an update with its base; the live version is checked first', async () => {
    db.tables['page_visibility'] = [aboutRow()];
    const stale = await callRoute(db, (await screen()).PUT, 'PUT', API, {
      body: body({ mode: 'link', version: 2 }),
    });
    expect(stale.status).toBe(409);
    expect(drafts()).toEqual([]);
    const res = await callRoute(db, (await screen()).PUT, 'PUT', API, {
      body: body({ mode: 'link', version: 3 }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(drafts()[0]).toMatchObject({
      entity_id: ABOUT_ROW,
      op: 'update',
      base_version: 3,
      base: { mode: 'hidden', hide_from: '2026-11-01T21:00:00.000Z' },
    });
    expect(liveWritesOf(db, 'page_visibility')).toEqual([]);
  });

  it('a pending change must be named: without it 409, with it the change moves on', async () => {
    db.tables['page_visibility'] = [aboutRow()];
    db.tables['content_drafts'] = [
      draftRow({
        entity_type: 'page_visibility',
        entity_id: ABOUT_ROW,
        payload: body({ mode: 'link' }),
        base: { mode: 'hidden' },
        base_version: 3,
      }),
    ];
    const unnamed = await callRoute(db, (await screen()).PUT, 'PUT', API, {
      body: body({ mode: 'public', version: 3 }),
    });
    expect(unnamed.status).toBe(409);
    const named = await callRoute(db, (await screen()).PUT, 'PUT', API, {
      body: {
        ...body({ mode: 'public', version: 3 }),
        draftId: '77777777-7777-4777-8777-000000000001',
        draftVersion: 1,
        staged: true,
      },
    });
    expect(named.status, JSON.stringify(named.body)).toBe(200);
    expect(drafts()[0]).toMatchObject({ version: 2, payload: { mode: 'public' } });
  });

  it('the save’s own rules run at stage time: the homepage stays visible (422)', async () => {
    const res = await callRoute(db, (await screen()).PUT, 'PUT', API, {
      body: body({ target: { pageId: HOME }, mode: 'link' }),
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain(HOME_REFUSAL);
    expect(drafts()).toEqual([]);
  });

  it('the alias stages too, as "only people with the link"', async () => {
    const res = await callRoute(
      db,
      (await alias()).PATCH,
      'PATCH',
      `/api/admin/pages/visibility/${ABOUT}`,
      {
        body: { navVisible: false, version: 0 },
        params: { id: ABOUT },
      },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(drafts()[0]).toMatchObject({ op: 'create', payload: { mode: 'link' } });
    expect(liveWritesOf(db, 'page_visibility')).toEqual([]);
  });
});

describe('releases off: main’s path, and a save made in release mode is refused', () => {
  beforeEach(() => {
    db.flag = false;
  });

  it('a plain save writes live, syncs and purges, as before', async () => {
    const res = await callRoute(db, (await screen()).PUT, 'PUT', API, { body: body() });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(liveWritesOf(db, 'page_visibility')).toHaveLength(1);
    expect(drafts()).toEqual([]);
    expect(edge).toEqual({ syncs: 1, purges: 1 });
    expect(auditsOf(db)).toEqual(['page_visibility.update']);
  });

  it('a save marked as made in release mode: 409 releases-off, nothing written', async () => {
    for (const mark of [
      { staged: true },
      { draftId: '77777777-7777-4777-8777-000000000001', draftVersion: 1 },
    ]) {
      const res = await callRoute(db, (await screen()).PUT, 'PUT', API, {
        body: { ...body(), ...mark },
      });
      expect(res.status).toBe(409);
      expect(res.body['error']).toBe('releases-off');
    }
    expect(liveWritesOf(db, 'page_visibility')).toEqual([]);
  });

  it('a bad body is still a 422 before anything is read', async () => {
    const res = await callRoute(db, (await screen()).PUT, 'PUT', API, {
      body: { ...body(), mode: 'password' },
    });
    expect(res.status).toBe(422);
    expect(db.calls.filter((c) => c.kind === 'from')).toEqual([]);
  });

  it('the password door marked as made in release mode: 409 releases-off', async () => {
    const res = await callRoute(db, (await password()).POST, 'POST', `${API}/password?staged=1`, {
      body: { pageId: ABOUT, password: 'open sesame', note: null, version: 0 },
    });
    expect(res.status).toBe(409);
    expect(rpcs('set_page_password')).toEqual([]);
  });
});

describe('the password door with releases on: immediate only where the guard lets it', () => {
  const ask = async (over: Row = {}) =>
    callRoute(db, (await password()).POST, 'POST', `${API}/password?staged=1`, {
      body: { pageId: ABOUT, password: 'open sesame', note: { en: 'Ask us' }, version: 3, ...over },
    });

  beforeEach(() => {
    db.rpc = (fn) => (fn === 'set_page_password' ? { data: null, error: null } : undefined);
  });

  it('a page not behind a password live: refused in words, the database never asked', async () => {
    db.tables['page_visibility'] = [aboutRow()];
    const res = await ask();
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain(RELEASE_PASSWORD_ONLY);
    expect(rpcs('set_page_password')).toEqual([]);
  });

  it('a page behind a password with a pending change: refused', async () => {
    db.tables['page_visibility'] = [
      aboutRow({ mode: 'password', hide_from: null, note: { en: 'Ask us' } }),
    ];
    db.tables['content_drafts'] = [
      draftRow({
        entity_type: 'page_visibility',
        entity_id: ABOUT_ROW,
        payload: body({ mode: 'public' }),
      }),
    ];
    const res = await ask();
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain(RELEASE_PASSWORD_PENDING);
    expect(rpcs('set_page_password')).toEqual([]);
  });

  it('a new message: refused, the message stays as it is', async () => {
    db.tables['page_visibility'] = [
      aboutRow({ mode: 'password', hide_from: null, note: { en: 'Ask us' } }),
    ];
    const res = await ask({ note: { en: 'Ask us first' } });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain(RELEASE_NOTE_KEPT);
    expect(rpcs('set_page_password')).toEqual([]);
  });

  it('a new password for a page that asks for one, the message unchanged: set at once', async () => {
    db.tables['page_visibility'] = [
      aboutRow({ mode: 'password', hide_from: null, note: { en: 'Ask us' } }),
    ];
    const res = await ask();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(rpcs('set_page_password')).toHaveLength(1);
    expect(drafts()).toEqual([]);
  });
});
