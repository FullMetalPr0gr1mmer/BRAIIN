import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIContext } from 'astro';

// The leads write API (Admin v2 C3), past assertCap (tests/authz/cases/leadsWrite.ts holds
// the role matrix). What each route must do, in order:
//   • PATCH: a pipeline change goes through the version the caller read (409 when it moved
//     on, never an overwrite); a star, a read mark or a logged contact needs no version;
//     the audit row names fields, never values.
//   • bulk: ONE call to public.leads_bulk_update as the caller, then ONE audit insert with a
//     row per changed lead and one for the batch; every lead comes back by outcome.
//   • manual add: leads.pii and a live recheck; the e-mail and phone go out encrypted and
//     blind-indexed, never in the clear; a phone that matches an earlier lead (and no
//     e-mail match) is a 409 with the matches and nothing ingested, unless createNew.
//   • erase: live recheck, the erase limit, the RLS read, the attempt audit WRITTEN (no row,
//     no erase), the service-role door with the session's tenant and person, the outcome.
//   • note delete: the same, audited before the door.

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';
const LEAD = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const NOTE = '44444444-4444-4444-8444-444444444444';
const STAGE = '55555555-5555-4555-8555-555555555555';

let auditOk = true;
let auditManyOk = true;
let limited = false;
let rlsSeesLead = true;
let currentVersion = 3;
let raceLost = false;
let liveProfile: Record<string, unknown> = { role: 'admin', is_active: true, locked_until: null };
let callerRpc: Record<string, { data: unknown; error: unknown }> = {};
let serviceRpc: Record<string, { data: unknown; error: unknown }> = {};
const events: string[] = [];
const audits: { action: string; entityId?: string; detail?: Record<string, unknown> }[] = [];
const auditBatches: { action: string; entityId?: string; detail?: Record<string, unknown> }[][] =
  [];
const claimed: { op: string; limits: unknown }[] = [];
const updates: { values: Record<string, unknown>; filters: Record<string, unknown> }[] = [];
const rpcCalls: { owner: string; fn: string; args: Record<string, unknown> }[] = [];

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
  writeAuditMany: async (
    _sb: unknown,
    _auth: unknown,
    entries: { action: string; entityId?: string; detail?: Record<string, unknown> }[],
  ) => {
    events.push(`audit-many:${entries.length}`);
    auditBatches.push(entries);
    return auditManyOk;
  },
}));
vi.mock('@/lib/crypto/pii', () => ({
  encryptPII: async (v: string) => `enc(${v})`,
  decryptPII: async (v: string) => v,
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
      claimed.push({ op, limits });
      if (limited) throw new RateLimitError(`${op}:user`);
    },
  };
});
vi.mock('@/lib/leads/interestLabel', () => ({
  resolveLeadInterests: async () => new Map(),
  withInterestLabels: (r: Record<string, unknown>) => r,
}));

/** A chainable stand-in recording what it was asked, as `owner` ('rls' or 'svc'). */
function builder(table: string, owner: 'rls' | 'svc') {
  const filters: Record<string, unknown> = {};
  let values: Record<string, unknown> | null = null;
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'order', 'limit', 'in', 'range', 'gte', 'lte']) b[m] = () => b;
  b['eq'] = (column: string, value: unknown) => {
    filters[column] = value;
    return b;
  };
  b['update'] = (v: Record<string, unknown>) => {
    values = v;
    return b;
  };
  b['maybeSingle'] = async () => {
    if (table === 'profiles') {
      events.push(`${owner}:profiles`);
      return { data: liveProfile, error: null };
    }
    if (values) {
      updates.push({ values, filters: { ...filters } });
      events.push(`${owner}:update:${table}`);
      if (raceLost) return { data: null, error: null };
      return { data: { id: LEAD, name: 'Sara', version: currentVersion + 1 }, error: null };
    }
    events.push(`${owner}:read:${table}`);
    if (table === 'leads' && !rlsSeesLead) return { data: null, error: null };
    return { data: { id: LEAD, version: currentVersion, lead_number: 7 }, error: null };
  };
  b['then'] = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
  return b;
}

function rpc(
  owner: 'rls' | 'svc',
  answers: () => Record<string, { data: unknown; error: unknown }>,
) {
  return async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ owner, fn, args });
    events.push(`${owner}:rpc:${fn}`);
    return answers()[fn] ?? { data: null, error: null };
  };
}

vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({
    from: (table: string) => builder(table, 'svc'),
    rpc: rpc('svc', () => serviceRpc),
  }),
}));

function ctx(
  path: string,
  method: string,
  body?: unknown,
  params: Record<string, string> = { id: LEAD },
  role = 'admin',
): APIContext {
  const url = new URL(`https://www.braiinstation.com${path}`);
  return {
    request: new Request(url, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    }),
    url,
    params,
    locals: {
      session: { userId: USER, tenantId: TENANT, role, email: 'a@x', isActive: true },
      supabase: {
        from: (table: string) => builder(table, 'rls'),
        rpc: rpc('rls', () => callerRpc),
      },
    },
  } as unknown as APIContext;
}

const lead = await import('@/pages/api/admin/leads/[id]');
const bulk = await import('@/pages/api/admin/leads/bulk');
const leads = await import('@/pages/api/admin/leads/index');
const erase = await import('@/pages/api/admin/leads/[id]/erase');
const noteDelete = await import('@/pages/api/admin/leads/[id]/notes/[noteId]');
const { CRM_ERASE_LIMITS } = await import('@/lib/admin/rateLimit');
const { blindIndex } = await import('@/lib/crm/blindIndex');
const { LEAD_PII_ENC_KEY } = await import('astro:env/server');

beforeEach(() => {
  auditOk = true;
  auditManyOk = true;
  limited = false;
  rlsSeesLead = true;
  currentVersion = 3;
  raceLost = false;
  liveProfile = { role: 'admin', is_active: true, locked_until: null };
  callerRpc = {};
  serviceRpc = {};
  events.length = 0;
  audits.length = 0;
  auditBatches.length = 0;
  claimed.length = 0;
  updates.length = 0;
  rpcCalls.length = 0;
});

const patch = (body: unknown, role = 'admin') =>
  lead.PATCH(ctx(`/api/admin/leads/${LEAD}`, 'PATCH', body, { id: LEAD }, role));

describe('PATCH /api/admin/leads/[id]', () => {
  it('a pipeline change is written at the version read, and answers with the new one', async () => {
    const res = await patch({ version: 3, stageId: STAGE, assignedTo: OTHER, tags: ['VIP'] });
    expect(res.status).toBe(200);
    expect(updates).toEqual([
      {
        values: { stage_id: STAGE, assigned_to: OTHER, tags: ['VIP'] },
        filters: { tenant_id: TENANT, id: LEAD, version: 3 },
      },
    ]);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data['version']).toBe(4);
  });

  it('a stale version is a 409, and nothing is written', async () => {
    const res = await patch({ version: 2, stageId: STAGE });
    expect(res.status).toBe(409);
    expect(updates).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('a race lost between the read and the write is a 409 too, never a silent overwrite', async () => {
    raceLost = true;
    expect((await patch({ version: 3, valueSar: 5000 })).status).toBe(409);
  });

  it('a pipeline change without the version read is refused before anything is read', async () => {
    for (const body of [{ stageId: STAGE }, { isSpam: true }, { valueSar: 1 }, { tags: [] }]) {
      expect((await patch(body)).status, JSON.stringify(body)).toBe(422);
    }
    expect(events).toEqual([]);
  });

  it('a star, a read mark and a logged contact need no version, and send only "now"', async () => {
    const res = await patch({ isStarred: true, read: true, logContact: { channel: 'call' } });
    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    const { values, filters } = updates[0]!;
    expect(filters).toEqual({ tenant_id: TENANT, id: LEAD });
    expect(Object.keys(values).sort()).toEqual(
      ['is_starred', 'last_contact_at', 'last_contact_channel', 'read_at'].sort(),
    );
    expect(values['last_contact_channel']).toBe('call');
    expect(typeof values['read_at']).toBe('string');
    expect(await patch({ read: false })).toHaveProperty('status', 200);
    expect(updates[1]!.values).toEqual({ read_at: null });
  });

  it('the audit row names fields and the stage, never tag words or values', async () => {
    await patch({ version: 3, stageId: STAGE, tags: ['Husband of a client'], valueSar: 9000 });
    expect(audits).toEqual([
      {
        action: 'lead.update',
        entityType: 'lead',
        entityId: LEAD,
        detail: { fields: ['stage_id', 'value_sar', 'tags'], status: null, stage: STAGE },
      },
    ]);
    expect(JSON.stringify(audits)).not.toContain('Husband');
    expect(JSON.stringify(audits)).not.toContain('9000');
  });

  it('refuses what it does not know, and a legacy status mixed with the pipeline', async () => {
    expect((await patch({ version: 3, score: 100 })).status).toBe(422);
    expect((await patch({ status: 'done', stageId: STAGE, version: 3 })).status).toBe(422);
    expect((await patch({ version: 3 })).status).toBe(422);
    expect((await patch({ tags: ['a', 'a'], version: 3 })).status).toBe(422);
    expect(updates).toEqual([]);
  });

  it('the legacy panel still saves a status and its notes (the expand window)', async () => {
    const res = await patch({ status: 'in_progress', internalNotes: 'Sent the proposal' });
    expect(res.status).toBe(200);
    expect(updates[0]!.values).toEqual({
      status: 'in_progress',
      internal_notes: 'Sent the proposal',
    });
    // Notes are a leads.pii column: the profile is rechecked first.
    expect(events.indexOf('svc:profiles')).toBeLessThan(events.indexOf('rls:update:leads'));
  });
});

describe('POST /api/admin/leads/bulk', () => {
  it('one call as the caller, outcomes back by kind, and ONE audit insert', async () => {
    callerRpc = {
      leads_bulk_update: {
        data: [
          { lead_id: LEAD, lead_version: 5, outcome: 'applied' },
          { lead_id: OTHER, lead_version: 9, outcome: 'conflict' },
          { lead_id: NOTE, lead_version: null, outcome: 'missing' },
          { lead_id: STAGE, lead_version: 2, outcome: 'skipped' },
          { lead_id: 'x', lead_version: 1, outcome: 'deleted' },
        ],
        error: null,
      },
    };
    const items = [LEAD, OTHER, NOTE, STAGE].map((id) => ({ id, version: 1 }));
    const res = await bulk.POST(
      ctx('/api/admin/leads/bulk', 'POST', { action: 'tagAdd', value: 'Hot', items }),
    );
    expect(res.status).toBe(200);
    expect(rpcCalls).toEqual([
      {
        owner: 'rls',
        fn: 'leads_bulk_update',
        args: { p_tenant: TENANT, p_action: 'tagAdd', p_value: 'Hot', p_items: items },
      },
    ]);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toEqual({
      applied: [{ id: LEAD, version: 5 }],
      conflicts: [{ id: OTHER, version: 9 }],
      missing: [NOTE],
      skipped: [STAGE],
    });
    expect(auditBatches).toHaveLength(1);
    expect(auditBatches[0]!.map((e) => `${e.action}:${e.entityId ?? ''}`)).toEqual([
      `lead.update:${LEAD}`,
      'lead.bulk:',
    ]);
    expect(auditBatches[0]![1]!.detail).toEqual({
      action: 'tagAdd',
      requested: 4,
      applied: 1,
      conflicts: 1,
      missing: 1,
      skipped: 1,
    });
    expect(JSON.stringify(auditBatches)).not.toContain('Hot');
    // No audit row per lead as its own request: the Free plan's 50 subrequests.
    expect(audits).toEqual([]);
  });

  it('a hundred leads still cost one change call and one audit insert', async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      version: 1,
    }));
    callerRpc = {
      leads_bulk_update: {
        data: items.map((item) => ({ lead_id: item.id, lead_version: 2, outcome: 'applied' })),
        error: null,
      },
    };
    const res = await bulk.POST(
      ctx('/api/admin/leads/bulk', 'POST', { action: 'stage', value: STAGE, items }),
    );
    expect(res.status).toBe(200);
    expect(rpcCalls).toHaveLength(1);
    expect(auditBatches).toHaveLength(1);
    expect(auditBatches[0]).toHaveLength(101);
  });

  it('refuses more than 100 leads, a lead twice, a versioned action without versions, and a delete', async () => {
    const many = Array.from({ length: 101 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      version: 1,
    }));
    for (const body of [
      { action: 'star', value: true, items: many },
      { action: 'star', value: true, items: [{ id: LEAD }, { id: LEAD }] },
      { action: 'stage', value: STAGE, items: [{ id: LEAD }] },
      { action: 'delete', value: true, items: [{ id: LEAD, version: 1 }] },
      { action: 'star', value: 'yes', items: [{ id: LEAD }] },
    ]) {
      const res = await bulk.POST(ctx('/api/admin/leads/bulk', 'POST', body));
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(422);
    }
    expect(rpcCalls).toEqual([]);
  });

  it('a value the database refuses is a 422 naming the field, with nothing audited', async () => {
    callerRpc = {
      leads_bulk_update: {
        data: null,
        error: {
          code: '23514',
          message:
            'the assignee must be an active lead worker of this tenant (constraint "leads_assignee_active")',
        },
      },
    };
    const res = await bulk.POST(
      ctx('/api/admin/leads/bulk', 'POST', {
        action: 'assign',
        value: OTHER,
        items: [{ id: LEAD, version: 1 }],
      }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { field?: string }).field).toBe('assignedTo');
    expect(auditBatches).toEqual([]);
  });
});

describe('POST /api/admin/leads (added by hand)', () => {
  const add = (body: Record<string, unknown>, role = 'admin') =>
    leads.POST(ctx('/api/admin/leads', 'POST', body, {}, role));
  const base = { name: 'Sara', message: 'Called about a booth', channel: 'phone' };

  it('encrypts and indexes, then ingests as the service role: manual, by the session user', async () => {
    const res = await add({
      ...base,
      email: 'Sara@Acme.SA',
      phone: '050 123 4567',
      budgetBand: 'gt_200k',
      timeline: 'Before Ramadan',
      company: 'Acme',
    });
    expect(res.status).toBe(200);
    const ingest = rpcCalls.find((c) => c.fn === 'crm_ingest_lead')!;
    expect(ingest.owner).toBe('svc');
    expect(ingest.args['p_tenant']).toBe(TENANT);
    const sent = ingest.args['p_lead'] as Record<string, unknown>;
    expect(sent['source']).toBe('manual');
    expect(sent['channel']).toBe('phone');
    expect(sent['created_by']).toBe(USER);
    expect(sent['email_enc']).toBe('enc(Sara@Acme.SA)');
    expect(sent['budget_enc']).toBe('enc(gt_200k)');
    expect(sent['timeline_text_enc']).toBe('enc(Before Ramadan)');
    expect(sent['email_hmac']).toBe(
      await blindIndex(LEAD_PII_ENC_KEY, 'email', TENANT, 'sara@acme.sa'),
    );
    expect(sent['phone_hmac']).toBe(
      await blindIndex(LEAD_PII_ENC_KEY, 'phone', TENANT, '+966501234567'),
    );
    expect([...(sent['score_signals'] as string[])].sort()).toEqual(
      [
        'budget_200k_plus',
        'budget_given',
        'company_email',
        'company_named',
        'timeline_given',
      ].sort(),
    );
    // Nothing in the clear but the name, the company and the message.
    const flat = JSON.stringify(sent);
    for (const clear of ['Sara@Acme.SA"', '"050 123 4567', '"gt_200k', '"Before Ramadan']) {
      expect(flat).not.toContain(clear);
    }
    expect(audits.map((a) => a.action)).toEqual(['lead.create']);
    expect(JSON.stringify(audits)).not.toContain('Acme');
  });

  it('the duplicate checks send only blind indexes, as the caller', async () => {
    await add({ ...base, email: 'sara@acme.sa', phone: '0501234567' });
    const lookups = rpcCalls.filter((c) => c.fn === 'leads_list');
    expect(lookups.map((c) => c.owner)).toEqual(['rls', 'rls']);
    expect(JSON.stringify(lookups)).not.toContain('sara@acme.sa');
    expect(JSON.stringify(lookups)).not.toContain('0501234567');
    expect((lookups[0]!.args['p_filter'] as Record<string, unknown>)['contact_kind']).toBe('email');
  });

  it('a phone that matches an earlier lead, with no e-mail match: 409 with the matches, nothing added', async () => {
    callerRpc = {
      leads_list: {
        data: { total: 1, rows: [{ id: OTHER, lead_number: 12, name: 'Sara A.' }] },
        error: null,
      },
    };
    const res = await add({ ...base, phone: '0501234567' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'possible-duplicate',
      matches: [{ id: OTHER, lead_number: 12, name: 'Sara A.' }],
    });
    expect(rpcCalls.some((c) => c.fn === 'crm_ingest_lead')).toBe(false);
    expect(audits).toEqual([]);
  });

  it('createNew says it is someone else: the lead is added', async () => {
    callerRpc = {
      leads_list: {
        data: { total: 1, rows: [{ id: OTHER, lead_number: 12, name: 'X' }] },
        error: null,
      },
    };
    const res = await add({ ...base, phone: '0501234567', createNew: true });
    expect(res.status).toBe(200);
    expect(rpcCalls.some((c) => c.fn === 'crm_ingest_lead')).toBe(true);
  });

  it('the same e-mail as an earlier lead is the same person: added, and named in the answer', async () => {
    callerRpc = {
      leads_list: {
        data: { total: 1, rows: [{ id: OTHER, lead_number: 3, name: 'Sara' }] },
        error: null,
      },
    };
    const res = await add({ ...base, email: 'sara@acme.sa', phone: '0501234567' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { sameEmail: unknown[] } };
    expect(body.data.sameEmail).toEqual([{ id: OTHER, lead_number: 3, name: 'Sara' }]);
    // The phone is not checked once the e-mail matched.
    expect(rpcCalls.filter((c) => c.fn === 'leads_list')).toHaveLength(1);
  });

  it('needs an e-mail or a phone, and takes no source from the client', async () => {
    expect((await add(base)).status).toBe(422);
    expect((await add({ ...base, phone: '0501234567', source: 'web_form' })).status).toBe(422);
    expect(rpcCalls).toEqual([]);
  });

  it('a demoted profile is refused at once: 403, nothing looked up or added', async () => {
    liveProfile = { role: 'seo', is_active: true, locked_until: null };
    expect((await add({ ...base, phone: '0501234567' })).status).toBe(403);
    expect(rpcCalls).toEqual([]);
  });

  it('a refusal by the database is a 422, never a retried insert', async () => {
    serviceRpc = { crm_ingest_lead: { data: null, error: { code: '23514' } } };
    expect((await add({ ...base, phone: '0501234567' })).status).toBe(422);
    expect(rpcCalls.filter((c) => c.fn === 'crm_ingest_lead')).toHaveLength(1);
  });
});

describe('POST /api/admin/leads/[id]/erase', () => {
  const run = (body: unknown = { reason: 'dsar' }) =>
    erase.POST(ctx(`/api/admin/leads/${LEAD}/erase`, 'POST', body));

  it('recheck, the erase limit, the RLS read, the attempt WRITTEN, the door, the outcome', async () => {
    serviceRpc = {
      crm_erase_lead: { data: { lead_number: 7, leads: 1, notes: 2, events: 5 }, error: null },
    };
    const res = await run();
    expect(res.status).toBe(200);
    expect(events).toEqual([
      'svc:profiles',
      'ops:crm-erase',
      'rls:read:leads',
      'audit:crm.erase.attempt',
      'svc:rpc:crm_erase_lead',
      'audit:crm.erase.outcome',
    ]);
    expect(claimed).toEqual([{ op: 'crm-erase', limits: CRM_ERASE_LIMITS }]);
    expect(CRM_ERASE_LIMITS).toEqual({ perUser: 20, perTenant: 50, windowMinutes: 60 });
    expect(rpcCalls.find((c) => c.fn === 'crm_erase_lead')!.args).toEqual({
      p_tenant: TENANT,
      p_lead: LEAD,
      p_actor: USER,
    });
    expect(audits[0]!.detail).toEqual({ target: 'lead', reason: 'dsar', lead_number: 7 });
    expect(audits[1]!.detail).toEqual({
      target: 'lead',
      status: 'ok',
      reason: 'dsar',
      lead_number: 7,
      leads: 1,
      notes: 2,
      events: 5,
    });
  });

  it('no attempt row: 403 and the door is never called', async () => {
    auditOk = false;
    expect((await run()).status).toBe(403);
    expect(rpcCalls).toEqual([]);
  });

  it('over the limit: 429, before any read', async () => {
    limited = true;
    expect((await run()).status).toBe(429);
    expect(events).toEqual(['svc:profiles', 'ops:crm-erase']);
  });

  it('a demoted profile: 403, before the limiter', async () => {
    liveProfile = { role: 'developer', is_active: true, locked_until: null };
    expect((await run()).status).toBe(403);
    expect(events).toEqual(['svc:profiles']);
  });

  it('a lead the caller cannot see: 404, nothing written', async () => {
    rlsSeesLead = false;
    expect((await run()).status).toBe(404);
    expect(audits).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });

  it('a door refusal is recorded as the outcome and answered without its text', async () => {
    serviceRpc = { crm_erase_lead: { data: null, error: { code: '42501', message: 'nope' } } };
    const res = await run();
    expect(res.status).toBe(403);
    expect(audits.map((a) => a.action)).toEqual(['crm.erase.attempt', 'crm.erase.outcome']);
    expect(audits[1]!.detail).toMatchObject({ status: 'failed', code: '42501' });
    serviceRpc = { crm_erase_lead: { data: null, error: { code: 'P0002' } } };
    expect((await run()).status).toBe(404);
  });

  it('needs a reason', async () => {
    expect((await run({})).status).toBe(422);
    expect((await run({ reason: 'because' })).status).toBe(422);
  });
});

describe('DELETE /api/admin/leads/[id]/notes/[noteId]', () => {
  const run = () =>
    noteDelete.DELETE(
      ctx(`/api/admin/leads/${LEAD}/notes/${NOTE}`, 'DELETE', undefined, {
        id: LEAD,
        noteId: NOTE,
      }),
    );

  it('recheck, the RLS read, the audit row WRITTEN, then the door', async () => {
    serviceRpc = { crm_delete_lead_note: { data: 'staff', error: null } };
    const res = await run();
    expect(res.status).toBe(200);
    expect(events).toEqual([
      'svc:profiles',
      'rls:read:leads',
      'audit:lead.note.delete',
      'svc:rpc:crm_delete_lead_note',
    ]);
    expect(rpcCalls[0]!.args).toEqual({
      p_tenant: TENANT,
      p_lead: LEAD,
      p_note: NOTE,
      p_actor: USER,
    });
    expect(await res.json()).toEqual({ ok: true, data: { deleted: true, source: 'staff' } });
  });

  it('no audit row: 403 and nothing deleted', async () => {
    auditOk = false;
    expect((await run()).status).toBe(403);
    expect(rpcCalls).toEqual([]);
  });

  it('a note that is not on this lead: 404', async () => {
    serviceRpc = { crm_delete_lead_note: { data: null, error: { code: 'P0002' } } };
    expect((await run()).status).toBe(404);
  });
});
