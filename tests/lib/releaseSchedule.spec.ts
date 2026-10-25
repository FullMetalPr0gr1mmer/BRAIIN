import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '@/lib/auth/types';
import { client, T, type Db, type Row } from '../fixtures/stagedDb';
import { ADMIN, callRoute, draftRow, makeDb } from '../fixtures/stagedRoute';

// Scheduling a release, moving it and cancelling it (Admin v2 R11) over the PostgREST stand-in:
// a schedule runs every step of a publish (R6) and then `apply_release` in `schedule` mode; a
// move or a cancel reads the release and the changes it holds as the person, checks every
// change is theirs to publish, re-reads them live, and calls the service-role function, whose
// refusals are mapped. The SQL is pgTAP's (release_schedule.test.sql); here its answers are
// scripted and the requests it receives asserted. Releases off: 409, and nothing else is read.

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
    from: (table: string) => client(svc.db).from(table),
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
const syncs = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/lib/admin/redirectSync', () => ({
  syncRedirectsOfTenant: async () => {
    syncs.count += 1;
    return { kvSynced: true, count: 0, truncated: false };
  },
}));
vi.mock('@/lib/admin/visibilitySync', () => ({
  rebuildVisibilitySnapshot: async () => {
    syncs.count += 1;
    return { snapshot: {}, kvSynced: true };
  },
}));

const { POST: PUBLISH } = await import('@/pages/api/admin/releases/index');
const { POST: VALIDATE } = await import('@/pages/api/admin/releases/validate');
const { PATCH: MOVE, DELETE: CANCEL } = await import('@/pages/api/admin/releases/[id]');
const { RELEASE_FAILURE_COPY, failureWords, FAILURE_NEXT } =
  await import('@/lib/release/failureCopy');
const { RELEASE_FAILURE_CODES, RELEASE_SCHEDULE_MIN_MINUTES, RELEASE_ISSUE_CODES } =
  await import('@schemas/release');
const { fireCheck } = await import('@/lib/cron/releases');

const BI = (en: string, ar: string) => ({ en, ar });
const id = (n: number) => `0f0f0f0f-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SERVICE = id(1);
const DISCIPLINE = id(2);
const NEW_SERVICE = id(7);
const NEW_CASE = id(8);
const REL = id(50);
const draftId = (n: number) => `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`;

const minutesAhead = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

function seed(tables: Record<string, Row[]> = {}): Db {
  const db = makeDb({
    profiles: [{ id: ADMIN, tenant_id: T, role: 'admin', is_active: true, locked_until: null }],
    services: [
      {
        id: SERVICE,
        tenant_id: T,
        slug: 'logo',
        title: BI('Logo Design', 'تصميم الشعار'),
        status: 'published',
        discipline_id: DISCIPLINE,
        poster_media_id: null,
        version: 3,
      },
    ],
    disciplines: [
      { id: DISCIPLINE, tenant_id: T, slug: 'branding', status: 'published', version: 1 },
    ],
    content_releases: [],
    ...tables,
  });
  svc.db = db;
  return db;
}

const titleEdit = (over: Row = {}) =>
  draftRow({
    id: draftId(1),
    entity_type: 'service',
    entity_id: SERVICE,
    op: 'update',
    payload: { title: BI('Logo', 'الشعار') },
    base: { title: BI('Logo Design', 'تصميم الشعار') },
    label: { en: 'Logo Design' },
    ...over,
  });

const select = (...drafts: Row[]) => ({
  items: drafts.map((d) => ({ draftId: d['id'], draftVersion: d['version'] })),
});

const callsOf = (fn: string) => svc.calls.filter((c) => c.fn === fn);

async function asRole(db: Db, role: Role) {
  db.tables['profiles'] = [{ id: ADMIN, tenant_id: T, role, is_active: true, locked_until: null }];
}

beforeEach(() => {
  svc.calls = [];
  svc.logs = [];
  svc.answer = () => ({ data: null, error: null });
  syncs.count = 0;
});

describe('scheduling a release (POST /api/admin/releases with scheduleAt)', () => {
  const scheduled = (at: string) => ({
    data: { mode: 'schedule', release_id: REL, scheduled_for: at, version: 1, item_count: 1 },
    error: null,
  });

  it('releases off: 409 releases-off, and nothing else is read', async () => {
    const db = seed({ content_drafts: [titleEdit()] });
    db.flag = false;
    const res = await callRoute(db, PUBLISH, 'POST', '/api/admin/releases', {
      body: { ...select(titleEdit()), scheduleAt: minutesAhead(60) },
    });
    expect(res.status).toBe(409);
    expect(res.body['error']).toBe('releases-off');
    expect(db.calls.filter((c) => c.kind === 'from')).toEqual([]);
    expect(svc.calls).toEqual([]);
  });

  it('a time under two minutes ahead, over 366 days ahead or with no offset is refused first', async () => {
    const db = seed({ content_drafts: [titleEdit()] });
    for (const at of [minutesAhead(1), minutesAhead(367 * 24 * 60)]) {
      const res = await callRoute(db, PUBLISH, 'POST', '/api/admin/releases', {
        body: { ...select(titleEdit()), scheduleAt: at },
      });
      expect(res.status, at).toBe(422);
      expect(res.body).toMatchObject({ error: 'validation', field: 'scheduleAt' });
    }
    expect(
      (
        await callRoute(db, PUBLISH, 'POST', '/api/admin/releases', {
          body: { ...select(titleEdit()), scheduleAt: '2030-01-01T10:00:00' },
        })
      ).status,
    ).toBe(422);
    // Nothing but the flag was read for any of them.
    expect(db.calls.filter((c) => c.kind === 'from')).toEqual([]);
    expect(svc.calls).toEqual([]);
    expect(
      (
        await callRoute(db, PUBLISH, 'POST', '/api/admin/releases', {
          body: {
            ...select(titleEdit()),
            scheduleAt: minutesAhead(RELEASE_SCHEDULE_MIN_MINUTES - 1),
          },
        })
      ).body['detail'],
    ).toBe('Choose a time at least 2 minutes from now.');
  });

  it('a rollback goes live when it is published: never scheduled', async () => {
    const db = seed({ content_drafts: [titleEdit()] });
    const res = await callRoute(db, PUBLISH, 'POST', '/api/admin/releases', {
      body: { ...select(titleEdit()), kind: 'rollback', scheduleAt: minutesAhead(60) },
    });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: 'validation', field: 'kind' });
    expect(svc.calls).toEqual([]);
  });

  it('a clean selection: every check of a publish, then apply_release in schedule mode, and no after-effect', async () => {
    const db = seed({ content_drafts: [titleEdit()] });
    const at = minutesAhead(90);
    svc.answer = (fn) => (fn === 'apply_release' ? scheduled(at) : { data: null, error: null });
    const res = await callRoute(db, PUBLISH, 'POST', '/api/admin/releases', {
      body: { ...select(titleEdit()), note: 'Launch', scheduleAt: at },
    });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({
      release: { id: REL, scheduledFor: at, version: 1 },
      items: [{ entityType: 'service', entityId: SERVICE, op: 'update' }],
      warnings: [],
    });
    const [apply] = callsOf('apply_release');
    expect(apply!.args).toMatchObject({
      p_actor: ADMIN,
      p_role: 'admin',
      p_mode: 'schedule',
      p_note: 'Launch',
      p_kind: 'publish',
      p_scheduled_for: at,
    });
    expect(apply!.args['p_items']).toEqual([
      {
        draft_id: draftId(1),
        draft_version: 1,
        entity_type: 'service',
        entity_id: SERVICE,
        op: 'update',
        patch: { title: BI('Logo', 'الشعار') },
        base: { title: BI('Logo Design', 'تصميم الشعار') },
      },
    ]);
    // Nothing is live yet: no purge record, no snapshot, no audit row of the Worker's (the
    // database writes release.schedule in the same transaction).
    expect(callsOf('record_release_purge')).toEqual([]);
    expect(syncs.count).toBe(0);
    // The person was re-read live (the service client's profiles read) before the apply.
    expect(db.calls.some((c) => c.kind === 'from' && c.name === 'profiles')).toBe(true);
  });

  it('its refusals are a publish’s: a conflict is 409 with the report, a busy database 503', async () => {
    const db = seed({ content_drafts: [titleEdit()] });
    svc.answer = (fn) =>
      fn === 'apply_release'
        ? {
            data: null,
            error: {
              code: 'BR409',
              message: 'conflict',
              details: JSON.stringify({
                code: 'conflict',
                items: [{ draftId: draftId(1), columns: ['title'] }],
              }),
            },
          }
        : { data: null, error: null };
    const conflict = await callRoute(db, PUBLISH, 'POST', '/api/admin/releases', {
      body: { ...select(titleEdit()), scheduleAt: minutesAhead(60) },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body['error']).toBe('conflict');
    svc.answer = (fn) =>
      fn === 'apply_release'
        ? { data: null, error: { code: '55P03', message: 'lock' } }
        : { data: null, error: null };
    const busy = await callRoute(db, PUBLISH, 'POST', '/api/admin/releases', {
      body: { ...select(titleEdit()), scheduleAt: minutesAhead(60) },
    });
    expect(busy.status).toBe(503);
    expect(busy.headers.get('retry-after')).toBe('5');
  });

  it('a change the Worker finds something wrong with stops the schedule: no apply', async () => {
    const db = seed({ content_drafts: [titleEdit({ payload: { title: { en: 'No Arabic' } } })] });
    const res = await callRoute(db, PUBLISH, 'POST', '/api/admin/releases', {
      body: { ...select(titleEdit()), scheduleAt: minutesAhead(60) },
    });
    expect(res.status).toBe(422);
    expect(callsOf('apply_release')).toEqual([]);
  });

  it('validate with a time checks it, then runs the dry run, never a schedule', async () => {
    const db = seed({ content_drafts: [titleEdit()] });
    svc.answer = (fn) =>
      fn === 'apply_release'
        ? {
            data: { mode: 'dry_run', ok: true, item_count: 1, conflicts: [], errors: [] },
            error: null,
          }
        : { data: null, error: null };
    const res = await callRoute(db, VALIDATE, 'POST', '/api/admin/releases/validate', {
      body: { ...select(titleEdit()), scheduleAt: minutesAhead(60) },
    });
    expect(res.status).toBe(200);
    expect(callsOf('apply_release').map((c) => c.args['p_mode'])).toEqual(['dry_run']);
    const late = await callRoute(db, VALIDATE, 'POST', '/api/admin/releases/validate', {
      body: { ...select(titleEdit()), scheduleAt: minutesAhead(1) },
    });
    expect(late.status).toBe(422);
  });

  it('a link to a pending new item a scheduled release holds is worded, never offered to tick', async () => {
    const service = draftRow({
      id: draftId(4),
      entity_type: 'service',
      entity_id: NEW_SERVICE,
      op: 'create',
      payload: { slug: 'motion', title: BI('Motion', 'حركة'), status: 'draft' },
      base: {},
      base_version: null,
      label: { en: 'Motion' },
      release_id: REL,
      version: 2,
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
    const res = await callRoute(db, VALIDATE, 'POST', '/api/admin/releases/validate', {
      body: select(caseBlock),
    });
    const [item] = res.data['items'] as Row[];
    expect(item!['requires']).toEqual([]);
    expect(item!['errors']).toEqual([
      expect.objectContaining({ code: 'requires-scheduled', field: 'serviceId' }),
    ]);
    expect(String((item!['errors'] as Row[])[0]!['message'])).toContain('Motion');
    expect(RELEASE_ISSUE_CODES).toContain('requires-scheduled');
  });
});

describe('moving and cancelling a scheduled release (PATCH / DELETE /api/admin/releases/[id])', () => {
  const release = (over: Row = {}): Row => ({
    id: REL,
    tenant_id: T,
    status: 'scheduled',
    version: 2,
    scheduled_for: minutesAhead(60),
    scheduled_by: ADMIN,
    ...over,
  });
  const claimed = (over: Row = {}) => titleEdit({ release_id: REL, version: 2, ...over });
  const move = (db: Db, body: unknown, role: Role = 'admin', path = `/api/admin/releases/${REL}`) =>
    callRoute(db, MOVE, 'PATCH', path, { body, role, params: { id: path.split('/').pop()! } });
  const cancel = (db: Db, query: string, role: Role = 'admin') =>
    callRoute(db, CANCEL, 'DELETE', `/api/admin/releases/${REL}${query}`, {
      role,
      params: { id: REL },
    });
  const moved = { data: { release_id: REL, scheduled_for: 'x', version: 3 }, error: null };

  it('releases off: 409 releases-off, and nothing else is read', async () => {
    const db = seed({ content_releases: [release()], content_drafts: [claimed()] });
    db.flag = false;
    expect((await move(db, { version: 2, scheduleAt: minutesAhead(30) })).status).toBe(409);
    expect((await cancel(db, '?version=2')).body['error']).toBe('releases-off');
    expect(db.calls.filter((c) => c.kind === 'from')).toEqual([]);
    expect(svc.calls).toEqual([]);
  });

  it('a release that is not one, not this site’s or no longer scheduled', async () => {
    const db = seed({
      content_releases: [release({ id: id(51), status: 'published' })],
      content_drafts: [],
    });
    expect(
      (
        await move(
          db,
          { version: 2, scheduleAt: minutesAhead(30) },
          'admin',
          '/api/admin/releases/nope',
        )
      ).status,
    ).toBe(404);
    expect((await move(db, { version: 2, scheduleAt: minutesAhead(30) })).status).toBe(404);
    const gone = await move(
      db,
      { version: 2, scheduleAt: minutesAhead(30) },
      'admin',
      `/api/admin/releases/${id(51)}`,
    );
    expect(gone.status).toBe(409);
    expect(gone.body['error']).toBe('not-scheduled');
    expect(svc.calls).toEqual([]);
  });

  it('a stale version is 409 conflict with the version the release is at', async () => {
    const db = seed({ content_releases: [release()], content_drafts: [claimed()] });
    const res = await move(db, { version: 1, scheduleAt: minutesAhead(30) });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'conflict', entity: 'release', version: 2 });
    expect(callsOf('reschedule_release')).toEqual([]);
  });

  it('every change must be the person’s to publish (P-2): 403 names who could move it', async () => {
    const db = seed({
      content_releases: [release()],
      content_drafts: [claimed({ payload: { status: 'archived' } })],
    });
    await asRole(db, 'content_creator');
    const cc = await move(db, { version: 2, scheduleAt: minutesAhead(30) }, 'content_creator');
    expect(cc.status).toBe(403);
    expect(cc.body).toMatchObject({ capability: 'content.archiveDelete', waitingFor: ['admin'] });
    db.tables['content_drafts'] = [claimed()];
    await asRole(db, 'seo');
    const seo = await cancel(db, '?version=2', 'seo');
    expect(seo.status).toBe(403);
    expect(seo.body['waitingFor']).toEqual(['admin', 'content_creator']);
    expect(svc.calls).toEqual([]);
  });

  it('a new time under two minutes ahead is 422', async () => {
    const db = seed({ content_releases: [release()], content_drafts: [claimed()] });
    const res = await move(db, { version: 2, scheduleAt: minutesAhead(1) });
    expect(res.status).toBe(422);
    expect(res.body['field']).toBe('scheduleAt');
  });

  it('a demoted person is refused by the live re-read, before the database is asked', async () => {
    const db = seed({ content_releases: [release()], content_drafts: [claimed()] });
    await asRole(db, 'content_creator');
    const res = await move(db, { version: 2, scheduleAt: minutesAhead(30) }, 'admin');
    expect(res.status).toBe(403);
    expect(callsOf('reschedule_release')).toEqual([]);
  });

  it('a move: reschedule_release as the person, at the version they saw', async () => {
    const db = seed({ content_releases: [release()], content_drafts: [claimed()] });
    const at = minutesAhead(30);
    svc.answer = (fn) => (fn === 'reschedule_release' ? moved : { data: null, error: null });
    const res = await move(db, { version: 2, scheduleAt: at });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ release: { id: REL, scheduledFor: 'x', version: 3 } });
    expect(callsOf('reschedule_release').map((c) => c.args)).toEqual([
      { p_actor: ADMIN, p_role: 'admin', p_release: REL, p_version: 2, p_scheduled_for: at },
    ]);
  });

  it('the database’s refusals in the same words', async () => {
    const db = seed({ content_releases: [release()], content_drafts: [claimed()] });
    const cases: [Row, number, string][] = [
      [{ code: 'BR403', message: 'x', details: '{"code":"actor"}' }, 403, 'forbidden'],
      [
        { code: 'BR409', message: 'x', details: '{"code":"not-scheduled","status":"published"}' },
        409,
        'not-scheduled',
      ],
      [
        { code: 'BR409', message: 'x', details: '{"code":"conflict","version":4}' },
        409,
        'conflict',
      ],
      [{ code: 'P0002', message: 'x' }, 404, 'not-found'],
      [{ code: '55000', message: 'x' }, 409, 'releases-off'],
      [{ code: '55P03', message: 'x' }, 503, 'busy'],
    ];
    for (const [error, status, code] of cases) {
      svc.answer = (fn) =>
        fn === 'reschedule_release' ? { data: null, error } : { data: null, error: null };
      const res = await move(db, { version: 2, scheduleAt: minutesAhead(30) });
      expect(res.status, String(error['code'])).toBe(status);
      expect(res.body['error'], String(error['code'])).toBe(code);
      // Never the database's own words.
      expect(JSON.stringify(res.body)).not.toContain('"x"');
    }
    svc.answer = (fn) =>
      fn === 'reschedule_release'
        ? { data: null, error: { code: '22023', message: 'a time' } }
        : { data: null, error: null };
    expect((await move(db, { version: 2, scheduleAt: minutesAhead(30) })).status).toBe(500);
  });

  it('a cancel names the version; then unschedule_release, its drafts pending again', async () => {
    const db = seed({ content_releases: [release()], content_drafts: [claimed()] });
    expect((await cancel(db, '')).status).toBe(422);
    expect((await cancel(db, '?version=zero')).status).toBe(422);
    svc.answer = (fn) =>
      fn === 'unschedule_release'
        ? { data: { release_id: REL, status: 'cancelled', released: 1 }, error: null }
        : { data: null, error: null };
    const res = await cancel(db, '?version=2');
    expect(res.status).toBe(200);
    expect(res.data).toEqual({
      release: { id: REL, status: 'cancelled' },
      released: 1,
      draftIds: [draftId(1)],
    });
    expect(callsOf('unschedule_release').map((c) => c.args)).toEqual([
      { p_actor: ADMIN, p_role: 'admin', p_release: REL, p_version: 2 },
    ]);
  });
});

describe('the Worker’s check before a fire (fireCheck)', () => {
  const due = (over: Row = {}) =>
    ({
      tenant_id: T,
      release_id: REL,
      scheduled_for: '2026-10-23T10:00:00+00:00',
      scheduled_by: ADMIN,
      kind: 'publish',
      scheduler: { role: 'content_creator', tenant_id: T, live: true },
      items: [{ entity_type: 'service', op: 'update', status: null }],
      ...over,
    }) as Parameters<typeof fireCheck>[0];

  it('a live scheduler whose role publishes every change fires as that role', () => {
    expect(fireCheck(due())).toEqual({ role: 'content_creator' });
  });

  it('the scheduler gone, not live, of another site, or not a publisher: scheduler', () => {
    for (const over of [
      { scheduler: null },
      { scheduled_by: null },
      { scheduler: { role: 'admin', tenant_id: T, live: false } },
      { scheduler: { role: 'admin', tenant_id: id(9), live: true } },
      { scheduler: { role: 'sales', tenant_id: T, live: true } },
    ]) {
      expect(fireCheck(due(over)), JSON.stringify(over)).toEqual({ failure: 'scheduler' });
    }
  });

  it('a role that no longer publishes a change, or a release of nothing: forbidden', () => {
    expect(
      fireCheck(due({ items: [{ entity_type: 'service', op: 'update', status: 'archived' }] })),
    ).toEqual({ failure: 'forbidden' });
    expect(fireCheck(due({ scheduler: { role: 'seo', tenant_id: T, live: true } }))).toEqual({
      failure: 'forbidden',
    });
    expect(fireCheck(due({ items: [] }))).toEqual({ failure: 'forbidden' });
    expect(
      fireCheck(
        due({
          scheduler: { role: 'admin', tenant_id: T, live: true },
          items: [{ entity_type: 'service', op: 'delete', status: null }],
        }),
      ),
    ).toEqual({ role: 'admin' });
  });
});

describe('the words of a failure', () => {
  it('every failure code has its line, plain, with no dashes (P-12)', () => {
    expect(Object.keys(RELEASE_FAILURE_COPY).sort()).toEqual([...RELEASE_FAILURE_CODES].sort());
    for (const line of [...Object.values(RELEASE_FAILURE_COPY), FAILURE_NEXT]) {
      expect(line).not.toMatch(/[–—]/);
      expect(line.endsWith('.')).toBe(true);
    }
    expect(failureWords('nonsense')).toBe(RELEASE_FAILURE_COPY.error);
    expect(failureWords('conflict')).toBe(RELEASE_FAILURE_COPY.conflict);
  });
});
