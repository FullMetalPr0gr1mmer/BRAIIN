import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIContext } from 'astro';

// The import route (Admin v2 C15, crm.md §12). Open runs the order a privileged bulk write
// needs: a live recheck, the import's own limit, the ATTEMPT audit row WRITTEN (no row, no
// import), then the door; an import left open gets its outcome row. A piece is parsed here,
// its rows checked and sealed: the door receives ciphertext and indexes, never an e-mail or a
// phone as typed, and the answer is row numbers and codes, never what a row held. Finish
// writes the OUTCOME row with counts only. A body over its cap is refused before it is read;
// a refusal never repeats what was sent.

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';
const BATCH = '22222222-2222-4222-8222-222222222222';
const EMAIL = 'sara.private@example.test';
const PHONE = '0501234567';

let auditOk = true;
let limited = false;
let liveProfile: Record<string, unknown> = { role: 'admin', is_active: true, locked_until: null };
const events: string[] = [];
const audits: { action: string; entityId?: string; detail?: Record<string, unknown> }[] = [];
const claims: { op: string; limits: unknown }[] = [];
const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
let rpcAnswers: Record<string, { data: unknown; error: unknown }> = {};

vi.mock('@/lib/admin/audit', () => ({
  writeAudit: async (
    _sb: unknown,
    _auth: unknown,
    entry: { action: string; entityId?: string; detail?: Record<string, unknown> },
  ) => {
    events.push(`audit:${entry.action}`);
    audits.push(entry);
    return auditOk;
  },
}));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));
vi.mock('@/lib/admin/rateLimit', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/admin/rateLimit')>('@/lib/admin/rateLimit');
  const { RateLimitError } = await import('@/lib/admin/errors');
  return {
    ...actual,
    claimPrivilegedOp: async (_a: unknown, op: string, limits?: unknown) => {
      events.push(`ops:${op}`);
      claims.push({ op, limits });
      if (limited) throw new RateLimitError(`${op}:user`);
    },
  };
});

function builder(table: string, owner: 'svc' | 'rls') {
  const b: Record<string, unknown> = {};
  for (const method of ['in', 'is', 'eq', 'order', 'limit', 'select']) b[method] = () => b;
  b['maybeSingle'] = async () => {
    events.push(`${owner}:${table}`);
    if (table === 'profiles') return { data: liveProfile, error: null };
    if (table === 'site_profile') return { data: { address_country: 'SA' }, error: null };
    return { data: null, error: null };
  };
  b['then'] = (ok: (v: unknown) => unknown) => {
    events.push(`${owner}:list:${table}`);
    const rows =
      table === 'crm_import_batches'
        ? [
            {
              id: BATCH,
              status: 'done',
              created_by: USER,
              created_at: '2026-11-11T10:00:00Z',
              finished_at: '2026-11-11T10:01:00Z',
              expected_rows: 3,
              rows_seen: 3,
              created_count: 2,
              duplicate_count: 1,
              repeat_count: 0,
              failed_count: 0,
              phone_match_count: 0,
              basis_counts: { consent: 2 },
              secret: EMAIL,
            },
          ]
        : [];
    return Promise.resolve({ data: rows, error: null }).then(ok);
  };
  return b;
}

function client(owner: 'svc' | 'rls') {
  return {
    from: (table: string) => builder(table, owner),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      events.push(`${owner}:rpc:${fn}`);
      rpcCalls.push({ fn, args });
      return rpcAnswers[fn] ?? { data: null, error: null };
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({ serviceClient: () => client('svc') }));

function ctx(path: string, method = 'GET', body?: unknown, raw?: string): APIContext {
  const url = new URL(`https://admin.example.test${path}`);
  return {
    request: new Request(url, {
      method,
      ...(body === undefined && raw === undefined
        ? {}
        : {
            body: raw ?? JSON.stringify(body),
            headers: { 'content-type': 'application/json' },
          }),
    }),
    url,
    params: {},
    locals: {
      session: { userId: USER, tenantId: TENANT, role: 'admin', email: 'a@x', isActive: true },
      supabase: client('rls'),
    },
  } as unknown as APIContext;
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const route = await import('@/pages/api/admin/crm/contacts/import/index');
const template = await import('@/pages/api/admin/crm/contacts/import/template');
const { CRM_IMPORT_LIMITS } = await import('@/lib/admin/rateLimit');

const URL_ = '/api/admin/crm/contacts/import';
const OPEN = { step: 'open', rows: 3, bytes: 300, attested: true };

beforeEach(() => {
  auditOk = true;
  limited = false;
  liveProfile = { role: 'admin', is_active: true, locked_until: null };
  events.length = 0;
  audits.length = 0;
  claims.length = 0;
  rpcCalls.length = 0;
  rpcAnswers = { crm_import_open: { data: { id: BATCH, stopped: [] }, error: null } };
});

describe('open', () => {
  it('live recheck, its own limit, the attempt row written, then the door', async () => {
    const res = await route.POST(ctx(URL_, 'POST', OPEN));
    expect(res.status).toBe(200);
    expect(events).toEqual([
      'svc:profiles',
      'ops:crm-import',
      'audit:crm.import.attempt',
      'svc:rpc:crm_import_open',
    ]);
    expect(claims).toEqual([{ op: 'crm-import', limits: CRM_IMPORT_LIMITS }]);
    expect(rpcCalls[0]?.args).toEqual({
      p_tenant: TENANT,
      p_actor: USER,
      p_rows: 3,
      p_bytes: 300,
      p_attestation: 'c15-v1',
    });
    expect(audits[0]?.detail).toEqual({ rows: 3, bytes: 300, attestation: 'c15-v1' });
    expect(((await json(res))['data'] as Record<string, unknown>)['batchId']).toBe(BATCH);
  });

  it('refuses with 403 and opens nothing when the attempt row is not written', async () => {
    auditOk = false;
    const res = await route.POST(ctx(URL_, 'POST', OPEN));
    expect(res.status).toBe(403);
    expect(rpcCalls).toEqual([]);
  });

  it('the sixth import in an hour is a 429, before any audit row or door', async () => {
    limited = true;
    const res = await route.POST(ctx(URL_, 'POST', OPEN));
    expect(res.status).toBe(429);
    expect(audits).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });

  it.each([
    [{ role: 'content_creator', is_active: true, locked_until: null }],
    [{ role: 'admin', is_active: false, locked_until: null }],
    [{ role: 'admin', is_active: true, locked_until: '2999-01-01T00:00:00Z' }],
  ])('a demoted, switched-off or locked profile is refused before the limit (%j)', async (p) => {
    liveProfile = p;
    const res = await route.POST(ctx(URL_, 'POST', OPEN));
    expect(res.status).toBe(403);
    expect(claims).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });

  it('an import this Admin left open gets its outcome row, counts only', async () => {
    rpcAnswers['crm_import_open'] = {
      data: {
        id: BATCH,
        stopped: [{ id: 'old', status: 'stopped', rows: 50, created: 48, failed: 2, name: 'x' }],
      },
      error: null,
    };
    await route.POST(ctx(URL_, 'POST', OPEN));
    expect(audits[1]).toEqual({
      action: 'crm.import.outcome',
      entityType: 'contact_import',
      entityId: 'old',
      detail: { status: 'stopped', left_open: true, rows: 50, created: 48, failed: 2 },
    });
  });

  it('a body the schema refuses gets fixed words, never what was sent', async () => {
    const res = await route.POST(ctx(URL_, 'POST', { ...OPEN, rows: EMAIL }));
    expect(res.status).toBe(422);
    const text = JSON.stringify(await json(res));
    expect(text).not.toContain(EMAIL);
    expect(text).toContain('The import request was not understood.');
    expect(events).toEqual([]);
  });

  it('a body over its cap is refused before it is parsed or anything is read', async () => {
    const res = await route.POST(
      ctx(URL_, 'POST', undefined, JSON.stringify({ step: 'rows', csv: 'x'.repeat(460_000) })),
    );
    expect(res.status).toBe(422);
    expect(events).toEqual([]);
  });
});

describe('a piece', () => {
  const piece = (csv: string, rowNumbers: number[]) => ({
    step: 'rows',
    batchId: BATCH,
    rowNumbers,
    csv,
  });

  it('is parsed here; the door gets ciphertext and indexes; the answer is numbers and codes', async () => {
    rpcAnswers['crm_import_rows'] = {
      data: { created: 1, duplicates: [], repeats: [], phone_matches: [], refused: [] },
      error: null,
    };
    const csv =
      'name,email,phone,lawful_basis,tags\n' +
      `Sara Private,${EMAIL},${PHONE},consent,vip\n` +
      `No Basis,${EMAIL.replace('sara', 'omar')},,,\n` +
      `,${EMAIL.replace('sara', 'huda')},,consent,\n`;
    const res = await route.POST(ctx(URL_, 'POST', piece(csv, [2, 5, 9])));
    expect(res.status).toBe(200);
    expect(events.slice(0, 1)).toEqual(['svc:profiles']);
    const call = rpcCalls.find((c) => c.fn === 'crm_import_rows');
    expect(call?.args['p_failed']).toBe(2);
    expect(call?.args['p_batch']).toBe(BATCH);
    expect(call?.args['p_actor']).toBe(USER);
    const sent = JSON.stringify(call?.args['p_rows']);
    expect(sent).not.toContain(EMAIL);
    expect(sent).not.toContain(PHONE);
    expect(sent).not.toContain('966501234567');
    const rows = call?.args['p_rows'] as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      row: 2,
      basis: 'consent',
      display_name: 'Sara Private',
      tags: ['vip'],
    });
    const channels = rows[0]?.['channels'] as Record<string, string>[];
    expect(channels.map((c) => c['kind'])).toEqual(['email', 'phone']);
    for (const c of channels) expect(c['value_hmac']).toMatch(/^[0-9a-f]{64}$/);
    const body = await json(res);
    expect(JSON.stringify(body)).not.toContain('private');
    expect(body['data']).toEqual({
      created: 1,
      duplicates: [],
      repeats: [],
      phoneMatches: [],
      problems: [
        { row: 5, problem: 'basis_missing' },
        { row: 9, problem: 'name_missing' },
      ],
    });
    // No audit row per piece: the attempt and the outcome hold the import.
    expect(audits).toEqual([]);
  });

  it('a heading problem refuses the piece by column number, before the door', async () => {
    const res = await route.POST(
      ctx(URL_, 'POST', piece(`name,email,Email,lawful_basis\nSara,${EMAIL},x,consent\n`, [2])),
    );
    expect(res.status).toBe(422);
    const text = JSON.stringify(await json(res));
    expect(text).toContain('Column 3');
    expect(text).not.toContain(EMAIL);
    expect(rpcCalls).toEqual([]);
  });

  it('a piece whose people do not match its row numbers is refused', async () => {
    const res = await route.POST(
      ctx(URL_, 'POST', piece(`name,email,lawful_basis\nSara,${EMAIL},consent\n`, [2, 3])),
    );
    expect(res.status).toBe(422);
    expect(rpcCalls).toEqual([]);
  });

  it('a demoted profile sends no piece', async () => {
    liveProfile = { role: 'content_creator', is_active: true, locked_until: null };
    const res = await route.POST(
      ctx(URL_, 'POST', piece(`name,email,lawful_basis\nSara,${EMAIL},consent\n`, [2])),
    );
    expect(res.status).toBe(403);
    expect(rpcCalls).toEqual([]);
  });

  it.each([
    ['P0002', 404],
    ['54000', 422],
    ['42501', 403],
  ])('the door refusing with %s is a %s', async (code, status) => {
    rpcAnswers['crm_import_rows'] = { data: null, error: { code, message: EMAIL } };
    const res = await route.POST(
      ctx(URL_, 'POST', piece(`name,email,lawful_basis\nSara,${EMAIL},consent\n`, [2])),
    );
    expect(res.status).toBe(status);
    expect(JSON.stringify(await json(res))).not.toContain(EMAIL);
  });
});

describe('finish', () => {
  it('closes the import and writes the outcome row with counts only', async () => {
    rpcAnswers['crm_import_finish'] = {
      data: {
        id: BATCH,
        status: 'done',
        rows: 3,
        created: 2,
        duplicates: 1,
        repeats: 0,
        failed: 0,
        phone_matches: 0,
        bases: { consent: 2, 'bad key!': 9 },
        sample: EMAIL,
      },
      error: null,
    };
    const res = await route.POST(ctx(URL_, 'POST', { step: 'finish', batchId: BATCH }));
    expect(res.status).toBe(200);
    expect(events).toEqual([
      'svc:profiles',
      'svc:rpc:crm_import_finish',
      'audit:crm.import.outcome',
    ]);
    expect(audits[0]).toEqual({
      action: 'crm.import.outcome',
      entityType: 'contact_import',
      entityId: BATCH,
      detail: {
        status: 'done',
        rows: 3,
        created: 2,
        duplicates: 1,
        repeats: 0,
        failed: 0,
        phone_matches: 0,
        basis_consent: 2,
      },
    });
    expect(JSON.stringify(await json(res))).not.toContain(EMAIL);
    expect(rpcCalls[0]?.args['p_stopped']).toBe(false);
  });

  it('a stopped import says so', async () => {
    rpcAnswers['crm_import_finish'] = { data: { rows: 1 }, error: null };
    await route.POST(ctx(URL_, 'POST', { step: 'finish', batchId: BATCH, stopped: true }));
    expect(rpcCalls[0]?.args['p_stopped']).toBe(true);
    expect(audits[0]?.detail).toEqual({ status: 'stopped', rows: 1 });
  });

  it('an import already closed is a 404 with no outcome row', async () => {
    rpcAnswers['crm_import_finish'] = { data: null, error: { code: 'P0002' } };
    const res = await route.POST(ctx(URL_, 'POST', { step: 'finish', batchId: BATCH }));
    expect(res.status).toBe(404);
    expect(audits).toEqual([]);
  });
});

describe('GET the recent imports and the template', () => {
  it('lists the batches as the caller, named fields only', async () => {
    const res = await route.GET(ctx(URL_));
    const body = (await json(res))['data'] as { batches: Record<string, unknown>[] };
    expect(body.batches).toEqual([
      {
        id: BATCH,
        status: 'done',
        createdBy: USER,
        createdAt: '2026-11-11T10:00:00Z',
        finishedAt: '2026-11-11T10:01:00Z',
        expectedRows: 3,
        rows: 3,
        created: 2,
        duplicates: 1,
        repeats: 0,
        failed: 0,
        phoneMatches: 0,
      },
    ]);
    expect(events).toEqual(['rls:list:crm_import_batches']);
  });

  it('the template is an attachment, never cached or sniffed, its cells neutralised', async () => {
    const res = await template.GET(ctx(`${URL_}/template`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="contacts-import-template.csv"',
    );
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    // Decoded keeping the BOM (Response.text() would drop it).
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer());
    expect(text.startsWith('﻿"name","email","phone"')).toBe(true);
    expect(text.trim().split('\r\n')).toHaveLength(1);
  });
});
