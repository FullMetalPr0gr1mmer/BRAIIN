import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import { resetIds, T, type Db, type Row } from '../fixtures/stagedDb';
import { auditsOf, callRoute, draftRow, liveWritesOf, makeDb } from '../fixtures/stagedRoute';
import { HOME_REFUSAL } from '@/lib/admin/visibilityCopy';

// Page visibility in release mode (Admin v2 R14b), through the real routes over the PostgREST
// stand-in. `page_visibility` is a registry table guarded by 0066, so with releases on its
// routes must stage: the list shows each setting's pending change, a save is a pending change
// (a full replace keyed by its target), nothing live is written, synced or purged, and the
// password door (Admin v2 R14e) stores the secret at once and stages the mode and the message,
// the edge taking only a live gate's new version. Releases off, every route is what it was.

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
      entityId: ABOUT_ROW,
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

  it('two first saves at once: the database keeps one create per target, the second is a 409', async () => {
    // The second save read no pending create (the first had not committed), so it stages its
    // own under a new id; the partial unique index of 0128 refuses it and write_drafts
    // re-raises 23505 (R14b review). The Worker answers it as the conflict it is.
    db.fail = (call) =>
      call.kind === 'rpc' && call.name === 'write_drafts'
        ? {
            code: '23505',
            message:
              'duplicate key value violates unique constraint "content_drafts_one_visibility_create"',
          }
        : null;
    const res = await callRoute(db, (await screen()).PUT, 'PUT', API, {
      body: { ...body(), staged: true },
    });
    expect([res.status, res.body['error']]).toEqual([409, 'draft-conflict']);
    expect(liveWritesOf(db, 'page_visibility')).toEqual([]);
    expect(auditsOf(db)).toEqual([]);
    // Any other unique violation stays an error, never a conflict the screen would retry.
    db.fail = (call) =>
      call.kind === 'rpc' && call.name === 'write_drafts'
        ? { code: '23505', message: 'duplicate key value violates unique constraint "other"' }
        : null;
    const other = await callRoute(db, (await screen()).PUT, 'PUT', API, {
      body: { ...body(), staged: true },
    });
    expect(other.status).toBe(500);
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

describe('the password door with releases on: the secret at once, the mode and message staged (R14e)', () => {
  const PASSWORD = 'open sesame';
  const ask = async (over: Row = {}) =>
    callRoute(db, (await password()).POST, 'POST', `${API}/password?staged=1`, {
      body: { pageId: ABOUT, password: PASSWORD, note: { en: 'Ask us' }, version: 3, ...over },
    });
  const stores = () => rpcs('store_page_password');
  /** The stand-in for public.store_page_password: the live gate moves where it asks for one. */
  const storeAnswers = () => {
    db.rpc = (fn, args) => {
      if (fn !== 'store_page_password') return undefined;
      const row = (db.tables['page_visibility'] ?? []).find(
        (r) => r['page_id'] === args['p_page_id'] && r['mode'] === 'password',
      );
      if (!row) return { data: { live: false, passwordVersion: null }, error: null };
      row['password_version'] = Number(row['password_version']) + 1;
      row['version'] = Number(row['version']) + 1;
      return { data: { live: true, passwordVersion: row['password_version'] }, error: null };
    };
  };
  /** Every table the stand-in holds (drafts, audit rows, settings), as one text. */
  const everyTable = () => JSON.stringify(db.tables);

  beforeEach(storeAnswers);

  it('a page not behind a password live: the secret stored, the mode and the message staged', async () => {
    db.tables['page_visibility'] = [aboutRow()];
    const res = await ask();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(stores()).toHaveLength(1);
    expect(stores()[0]!.values).toEqual({ p_page_id: ABOUT, p_password: PASSWORD });
    // Nothing live moved, so nothing reaches the edge.
    expect(liveWritesOf(db, 'page_visibility')).toEqual([]);
    expect(edge).toEqual({ syncs: 0, purges: 0 });
    const [d] = drafts();
    expect(d).toMatchObject({ entity_type: 'page_visibility', entity_id: ABOUT_ROW, op: 'update' });
    expect(d!['payload']).toEqual({
      target: { pageId: ABOUT },
      mode: 'password',
      note: { en: 'Ask us' },
      redirectPageId: null,
      hideFrom: null,
      showOn: null,
    });
    expect([...(d!['fields'] as string[])].sort()).toEqual(['hide_from', 'mode', 'note']);
    expect(res.data).toMatchObject({
      staged: true,
      passwordLive: false,
      kvSynced: true,
      setting: { mode: 'hidden' },
      pending: { op: 'update', setting: { mode: 'password', note: { en: 'Ask us' } } },
    });
    expect(auditsOf(db)).toEqual(['page_visibility.draft_save']);
    // The password is in the call to the database and nowhere else: no draft, no audit row, no
    // setting, no answer.
    expect(everyTable()).not.toContain(PASSWORD);
    expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
  });

  it('a page with no setting: a pending create under a Worker id, keyed by its target', async () => {
    const res = await ask({ pageId: CONTACT, version: 0, note: null });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [d] = drafts();
    expect(d).toMatchObject({ op: 'create', base: {}, base_version: null });
    expect(d!['payload']).toMatchObject({
      target: { pageId: CONTACT },
      mode: 'password',
      note: null,
    });
    expect(res.data).toMatchObject({ setting: null, pending: { op: 'create' } });
    expect(everyTable()).not.toContain(PASSWORD);
  });

  it('a page behind a password live, its message kept: the new one works at once, nothing staged', async () => {
    db.tables['page_visibility'] = [
      aboutRow({ mode: 'password', hide_from: null, note: { en: 'Ask us' }, password_version: 4 }),
    ];
    const res = await ask();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(stores()).toHaveLength(1);
    expect(drafts()).toEqual([]);
    // The live gate's version moved, so the edge takes the snapshot the cookies are signed over.
    expect(edge).toEqual({ syncs: 1, purges: 1 });
    expect(res.data).toMatchObject({
      passwordLive: true,
      pending: null,
      setting: { mode: 'password', passwordVersion: 5, version: 4 },
    });
    expect(auditsOf(db)).toEqual([]);
  });

  it('a page behind a password live with a new message: the password at once, the message staged', async () => {
    db.tables['page_visibility'] = [
      aboutRow({ mode: 'password', hide_from: null, note: { en: 'Ask us' }, password_version: 4 }),
    ];
    const res = await ask({ note: { en: 'Ask us first', ar: 'اسألنا' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [d] = drafts();
    expect(d!['fields']).toEqual(['note']);
    // Staged against the row as the password left it.
    expect(d).toMatchObject({ base: { note: { en: 'Ask us' } }, base_version: 4 });
    expect(edge).toEqual({ syncs: 1, purges: 1 });
    expect(res.data).toMatchObject({
      passwordLive: true,
      pending: { setting: { note: { en: 'Ask us first', ar: 'اسألنا' } } },
    });
  });

  it('a pending change must be named, and a named one is replaced; the secret waits for the checks', async () => {
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
    const unnamed = await ask();
    expect([unnamed.status, unnamed.body['error']]).toEqual([409, 'draft-conflict']);
    expect(stores()).toEqual([]);
    const named = await ask({ draftId: '77777777-7777-4777-8777-000000000001', draftVersion: 1 });
    expect(named.status, JSON.stringify(named.body)).toBe(200);
    expect(stores()).toHaveLength(1);
    expect(drafts()[0]).toMatchObject({ version: 2, payload: { mode: 'password' } });
  });

  it('a change a scheduled release holds cannot move: 409, nothing stored', async () => {
    db.tables['page_visibility'] = [aboutRow()];
    db.tables['content_drafts'] = [
      draftRow({
        entity_type: 'page_visibility',
        entity_id: ABOUT_ROW,
        payload: body({ mode: 'link' }),
        release_id: '88888888-8888-4888-8888-000000000001',
      }),
    ];
    const res = await ask({ draftId: '77777777-7777-4777-8777-000000000001', draftVersion: 1 });
    expect([res.status, res.body['error']]).toEqual([409, 'scheduled']);
    expect(stores()).toEqual([]);
  });

  it('the live version is checked with nothing pending: a stale drawer is a 409, nothing stored', async () => {
    db.tables['page_visibility'] = [aboutRow()];
    const res = await ask({ version: 2 });
    expect(res.status).toBe(409);
    expect(stores()).toEqual([]);
    expect(drafts()).toEqual([]);
  });

  it('the homepage and a short password are refused before anything is stored', async () => {
    const home = await ask({ pageId: HOME, version: 0 });
    expect(home.status).toBe(422);
    expect(JSON.stringify(home.body)).toContain(HOME_REFUSAL);
    const short = await ask({ password: 'short' });
    expect(short.status).toBe(422);
    expect(stores()).toEqual([]);
    expect(drafts()).toEqual([]);
  });

  it('the database’s own refusals: a stale token is a 403, releases switched off a 409, nothing staged', async () => {
    db.tables['page_visibility'] = [aboutRow()];
    db.rpc = (fn) =>
      fn === 'store_page_password'
        ? { data: null, error: { code: '42501', message: 'store_page_password: no' } }
        : undefined;
    const stale = await ask();
    expect(stale.status).toBe(403);
    db.rpc = (fn) =>
      fn === 'store_page_password'
        ? { data: null, error: { code: '55000', message: 'releases are off' } }
        : undefined;
    const off = await ask();
    expect([off.status, off.body['error']]).toEqual([409, 'releases-off']);
    expect(drafts()).toEqual([]);
    expect(auditsOf(db)).toEqual([]);
  });

  it('the list’s PUT still refuses the password mode in release mode (it has no secret to set)', async () => {
    const res = await callRoute(db, (await screen()).PUT, 'PUT', API, {
      body: { ...body({ mode: 'password' }), staged: true },
    });
    expect(res.status).toBe(422);
    expect(drafts()).toEqual([]);
    expect(stores()).toEqual([]);
  });
});
