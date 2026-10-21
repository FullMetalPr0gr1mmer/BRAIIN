import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import { OTHER_TENANT, makeContext, serviceClientStub, type Principal } from './harness';
import { client, resetIds, type Call, type Db, type Row } from '../fixtures/stagedDb';

// The reorder route judges the whole request before it writes a row (Admin v2 hotfix H12).
// The matrix (endpoints.spec.ts, the "naming an archived row" cases) proves who is refused;
// this proves what a refused request leaves behind: nothing. The database is the in-memory
// stand-in of the staged-write specs (tests/fixtures/stagedDb.ts), which keeps tenants apart
// through the handler's own `.eq('tenant_id', …)`, so a row of another tenant is really out
// of reach here, as RLS keeps it in Postgres (pgTAP proves that half).
//
// Before H12 the route updated the rows one at a time with no transaction: a Content
// Creator's move naming an archived row moved the rows before it, then the archive gate
// refused the archived one (a 500, and a partial order); an id of another tenant matched
// nothing and the route answered 200 for a row it never moved.

vi.mock('@/lib/supabase/server', () => ({ serviceClient: serviceClientStub }));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LIVE_1 = '33333333-3333-4333-8333-333333333301';
const SHELVED = '33333333-3333-4333-8333-333333333302';
const LIVE_2 = '33333333-3333-4333-8333-333333333303';
const FOREIGN = '33333333-3333-4333-8333-333333333304';

const service = (id: string, tenant: string, status: string, sortOrder: number): Row => ({
  id,
  tenant_id: tenant,
  slug: `s-${id.slice(-2)}`,
  status,
  sort_order: sortOrder,
  version: 1,
});

let db: Db;

beforeEach(() => {
  resetIds();
  db = {
    tables: {
      services: [
        service(LIVE_1, T, 'draft', 10),
        service(SHELVED, T, 'archived', 20),
        service(LIVE_2, T, 'published', 30),
        service(FOREIGN, OTHER_TENANT, 'draft', 10),
      ],
      content_drafts: [],
      content_release_items: [],
      audit_log: [],
    },
    flag: false,
    calls: [],
    user: '11111111-1111-4111-8111-111111111111',
    now: () => new Date().toISOString(),
  };
});

/** The archive gate, as the database applies it: a non-Admin's update of `SHELVED` is 42501. */
function archiveGate(shelvedSortOrder: number) {
  return (call: Call) =>
    call.name === 'services' &&
    call.op === 'update' &&
    (call.values as Row)['sort_order'] === shelvedSortOrder
      ? {
          code: '42501',
          message: 'new row violates row-level security policy for table "services"',
        }
      : null;
}

async function reorder(principal: Principal, items: { id: string; sortOrder: number }[]) {
  const { POST } = (await import('@/pages/api/admin/services/reorder')) as { POST: APIRoute };
  const ctx = makeContext(principal, '/api/admin/services/reorder', { items }, 'POST');
  (ctx.locals as unknown as { supabase: unknown }).supabase = client(db);
  const res = (await POST(ctx)) as Response;
  return { status: res.status, body: (await res.json()) as Row };
}

const order = () =>
  Object.fromEntries(db.tables['services']!.map((r) => [r['id'], r['sort_order']]));
const versions = () =>
  Object.fromEntries(db.tables['services']!.map((r) => [r['id'], r['version']]));
const writes = () => db.calls.filter((c) => c.name === 'services' && c.op === 'update');
const audits = () => db.tables['audit_log']!.map((r) => r['action']);
const BEFORE = { [LIVE_1]: 10, [SHELVED]: 20, [LIVE_2]: 30, [FOREIGN]: 10 };

describe('POST /api/admin/<resource>/reorder — judged whole before any row is written (H12)', () => {
  it('a Content Creator naming an archived row: 403, and no row is written, the others included', async () => {
    db.fail = archiveGate(10);
    const res = await reorder('content_creator', [
      { id: LIVE_1, sortOrder: 20 },
      { id: SHELVED, sortOrder: 10 },
    ]);
    expect([res.status, res.body['error'], res.body['capability']]).toEqual([
      403,
      'forbidden',
      'content.archiveDelete',
    ]);
    expect(writes()).toEqual([]);
    expect(order()).toEqual(BEFORE);
    expect(audits()).toEqual([]);
  });

  it('an Admin naming the same rows: both are written', async () => {
    const res = await reorder('admin', [
      { id: LIVE_1, sortOrder: 20 },
      { id: SHELVED, sortOrder: 10 },
    ]);
    expect(res.status).toBe(200);
    expect(res.body['data']).toEqual({ reordered: 2 });
    expect(order()).toEqual({ ...BEFORE, [LIVE_1]: 20, [SHELVED]: 10 });
    expect(audits()).toEqual(['service.reorder']);
  });

  it('a Content Creator moving past the archived row (what the screen sends) is written, the archived row untouched', async () => {
    db.fail = archiveGate(20);
    const res = await reorder('content_creator', [
      { id: LIVE_1, sortOrder: 30 },
      { id: LIVE_2, sortOrder: 10 },
    ]);
    expect(res.status).toBe(200);
    expect(order()).toEqual({ ...BEFORE, [LIVE_1]: 30, [LIVE_2]: 10 });
    expect(versions()[SHELVED]).toBe(1);
  });

  it('an id of another tenant: 422, and nothing is written in either tenant', async () => {
    for (const principal of ['admin', 'content_creator'] as const) {
      db.calls = [];
      const res = await reorder(principal, [
        { id: LIVE_1, sortOrder: 20 },
        { id: FOREIGN, sortOrder: 5 },
      ]);
      expect([res.status, res.body['error'], res.body['field']], principal).toEqual([
        422,
        'validation',
        'items',
      ]);
      expect(String(res.body['detail'])).toMatch(/^Nothing was moved/);
      expect(writes(), principal).toEqual([]);
      expect(order(), principal).toEqual(BEFORE);
    }
    expect(audits()).toEqual([]);
  });

  it('an Admin of another tenant naming this tenant’s rows (other_tenant): 422, nothing written', async () => {
    const res = await reorder('other_tenant', [
      { id: LIVE_1, sortOrder: 30 },
      { id: LIVE_2, sortOrder: 10 },
    ]);
    // Its read is scoped to its own tenant, where neither id is a row; before H12 it answered
    // 200 having moved nothing.
    expect([res.status, res.body['error']]).toEqual([422, 'validation']);
    expect(writes()).toEqual([]);
    expect(order()).toEqual(BEFORE);
  });

  it('a deleted row named with a live one: 422, the live one not moved', async () => {
    db.tables['services'] = db.tables['services']!.filter((r) => r['id'] !== LIVE_2);
    const res = await reorder('content_creator', [
      { id: LIVE_1, sortOrder: 30 },
      { id: LIVE_2, sortOrder: 10 },
    ]);
    expect(res.status).toBe(422);
    expect(writes()).toEqual([]);
    expect(order()[LIVE_1]).toBe(10);
  });

  it('a row archived after the check is the database’s 403 (mapped), not a 500', async () => {
    // The residual race (assertReorderable reads, someone archives LIVE_2, the writes run):
    // the refusal is mapped as every other write's is. The row before it stays moved, onto
    // the number LIVE_2 still holds: the two now share 30, and no swap parts them (a swap
    // only exchanges two numbers already stored); setting either row's Sort order does.
    db.fail = archiveGate(10);
    const res = await reorder('content_creator', [
      { id: LIVE_1, sortOrder: 30 },
      { id: LIVE_2, sortOrder: 10 },
    ]);
    expect([res.status, res.body['error']]).toEqual([403, 'forbidden']);
    expect([order()[LIVE_1], order()[LIVE_2]]).toEqual([30, 30]);
  });

  describe('ids in capitals (a uuid is case-blind; Postgres answers in lowercase)', () => {
    // Rows whose ids hold hex letters, so their capital spelling differs. The route lowercases
    // the ids once, so the pre-check, the updates and the staged path all key on one spelling;
    // before, the pre-check compared the ids as sent with the ids Postgres answers, and refused
    // a real row as missing. (The stand-in compares strings, so a capital id that reached it
    // would match no row: it also proves the lowercase form is what is written.)
    const CASED_LIVE = 'abcdef00-3333-4333-8333-3333333333a1';
    const CASED_SHELVED = 'abcdef00-3333-4333-8333-3333333333a2';
    const CASED_OTHER = 'abcdef00-3333-4333-8333-3333333333a3';
    beforeEach(() => {
      db.tables['services']!.push(
        service(CASED_LIVE, T, 'draft', 40),
        service(CASED_SHELVED, T, 'archived', 50),
        service(CASED_OTHER, T, 'published', 60),
      );
    });

    it('an id in capitals is the row it names: moved, not refused as missing', async () => {
      const res = await reorder('content_creator', [
        { id: CASED_LIVE.toUpperCase(), sortOrder: 60 },
        { id: CASED_OTHER.toUpperCase(), sortOrder: 40 },
      ]);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body['data']).toEqual({ reordered: 2 });
      expect([order()[CASED_LIVE], order()[CASED_OTHER]]).toEqual([60, 40]);
    });

    it('an archived row named in capitals is still the archive rule’s: 403, nothing written', async () => {
      const res = await reorder('content_creator', [
        { id: CASED_LIVE, sortOrder: 50 },
        { id: CASED_SHELVED.toUpperCase(), sortOrder: 40 },
      ]);
      expect([res.status, res.body['capability']]).toEqual([403, 'content.archiveDelete']);
      expect(writes()).toEqual([]);
    });
  });
});
