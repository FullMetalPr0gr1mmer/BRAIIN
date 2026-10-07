import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIContext } from 'astro';

// One lead in the CRM (Admin v2 C2b): the reveal returns contact details only, after the
// live recheck, the limiter (with the real reveal limits) and a written audit row that
// names every field it returns; the notes thread opens only for a live holder who can see
// the lead, after its own written audit row, and a note is ONE insert whose author is the
// session's user; the timeline is read as the caller, a page at a time on (at, id).

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';
const LEAD = '22222222-2222-4222-8222-222222222222';
const NOTE = '33333333-3333-4333-8333-333333333333';

let auditOk = true;
let limited = false;
let rlsSeesLead = true;
let noteInsertFails = false;
let liveProfile: Record<string, unknown> = { role: 'admin', is_active: true, locked_until: null };
const events: string[] = [];
const audits: { action: string; detail?: Record<string, unknown> }[] = [];
const claimedLimits: unknown[] = [];
const inserts: { table: string; row: Record<string, unknown> }[] = [];
const filters: Record<string, unknown>[] = [];

/** Three timeline rows, newest first; 12 and 11 share one instant (one statement). */
const T2 = '2026-10-05T09:00:00.123456+00:00';
const T1 = '2026-10-05T08:00:00+00:00';
const TIMELINE = [
  { id: 12, at: T2, actor_id: null, kind: 'spam_cleared', detail: {} },
  { id: 11, at: T2, actor_id: null, kind: 'stage_changed', detail: {} },
  { id: 10, at: T1, actor_id: null, kind: 'created', detail: {} },
];

vi.mock('@/lib/admin/audit', () => ({
  writeAudit: async (
    _sb: unknown,
    _auth: unknown,
    entry: { action: string; detail?: Record<string, unknown> },
  ) => {
    events.push(`audit:${entry.action}`);
    audits.push(entry);
    return auditOk;
  },
}));
vi.mock('@/lib/crypto/pii', () => ({
  decryptPII: async (v: string) => v.replace(/^enc:/, ''),
}));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));
// The real module, with only the ledger call replaced: the limits the reveal passes are
// recorded, so a reveal that dropped them (falling back to the export's 3 an hour) fails.
vi.mock('@/lib/admin/rateLimit', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/admin/rateLimit')>('@/lib/admin/rateLimit');
  const { RateLimitError } = await import('@/lib/admin/errors');
  return {
    ...actual,
    claimPrivilegedOp: async (_a: unknown, op: string, limits?: unknown) => {
      events.push(`ops:${op}`);
      claimedLimits.push(limits);
      if (limited) throw new RateLimitError(`${op}:user`);
    },
  };
});

const GATED = {
  email_enc: 'enc:sara@acme.sa',
  phone_enc: 'enc:+966500000000',
  budget_enc: 'enc:gt_200k',
  timeline_text_enc: 'enc:Before Ramadan',
  timeline_band: null,
  internal_notes: 'old note',
  ip_inet: null,
};

/** The timeline a PostgREST `or` keyset filter leaves (the two forms the route may send). */
function applyCursor(f: Record<string, unknown>) {
  let rows = TIMELINE;
  const or = f['or'];
  if (typeof or === 'string') {
    const m = /^at\.lt\."([^"]+)",and\(at\.eq\."([^"]+)",id\.lt\.(\d+)\)$/.exec(or);
    if (!m) throw new Error(`unexpected cursor filter: ${or}`);
    rows = rows.filter((e) => e.at < m[1]! || (e.at === m[2]! && e.id < Number(m[3])));
  }
  if (typeof f['lt:at'] === 'string') rows = rows.filter((e) => e.at < (f['lt:at'] as string));
  return rows.slice(0, typeof f['limit'] === 'number' ? f['limit'] : rows.length);
}

/** A chainable stand-in recording what it was asked. */
function builder(table: string, owner: 'svc' | 'rls') {
  const f: Record<string, unknown> = {};
  const b: Record<string, unknown> = {};
  b['select'] = () => b;
  b['order'] = () => b;
  b['limit'] = (n: number) => {
    f['limit'] = n;
    return b;
  };
  b['lt'] = (column: string, value: unknown) => {
    f[`lt:${column}`] = value;
    return b;
  };
  b['or'] = (expr: string) => {
    f['or'] = expr;
    return b;
  };
  b['in'] = () => b;
  b['eq'] = (column: string, value: unknown) => {
    f[column] = value;
    return b;
  };
  b['insert'] = (row: Record<string, unknown>) => {
    inserts.push({ table, row });
    events.push(`${owner}:insert:${table}`);
    return b;
  };
  b['single'] = async () =>
    noteInsertFails
      ? { data: null, error: { message: 'insert failed' } }
      : { data: { id: NOTE, created_at: '2026-10-05T10:00:00Z' }, error: null };
  b['maybeSingle'] = async () => {
    events.push(`${owner}:${table}`);
    filters.push({ owner, table, ...f });
    if (table === 'profiles') return { data: liveProfile, error: null };
    if (table === 'leads' && owner === 'svc') return { data: GATED, error: null };
    if (table === 'leads' && !rlsSeesLead) return { data: null, error: null };
    return { data: { id: LEAD, name: 'Sara' }, error: null };
  };
  b['then'] = (ok: (v: unknown) => unknown) => {
    events.push(`${owner}:list:${table}`);
    filters.push({ owner, table, ...f });
    const data =
      table === 'lead_notes'
        ? [
            {
              id: NOTE,
              body: 'Sent the proposal',
              source: 'staff',
              created_by: USER,
              created_at: 'x',
            },
          ]
        : table === 'profiles'
          ? [{ id: USER, display_name: 'Amal' }]
          : table === 'lead_events'
            ? applyCursor(f)
            : [];
    return Promise.resolve({ data, error: null }).then(ok);
  };
  return b;
}

vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({ from: (table: string) => builder(table, 'svc') }),
}));

function ctx(path: string, method = 'GET', body?: unknown): APIContext {
  const url = new URL(`https://www.braiinstation.com${path}`);
  return {
    request: new Request(url, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    }),
    url,
    params: { id: LEAD },
    locals: {
      session: { userId: USER, tenantId: TENANT, role: 'admin', email: 'a@x', isActive: true },
      supabase: { from: (table: string) => builder(table, 'rls') },
    },
  } as unknown as APIContext;
}

const reveal = await import('@/pages/api/admin/leads/[id]/reveal');
const notes = await import('@/pages/api/admin/leads/[id]/notes');
const timeline = await import('@/pages/api/admin/leads/[id]/events');
const { PII_REVEAL_LIMITS } = await import('@/lib/admin/rateLimit');

beforeEach(() => {
  auditOk = true;
  limited = false;
  rlsSeesLead = true;
  noteInsertFails = false;
  liveProfile = { role: 'admin', is_active: true, locked_until: null };
  events.length = 0;
  audits.length = 0;
  claimedLimits.length = 0;
  inserts.length = 0;
  filters.length = 0;
});

describe('POST /[id]/reveal', () => {
  it('limiter, RLS read, written audit row, then the gated read; contact details only', async () => {
    const res = await reveal.POST(ctx(`/api/admin/leads/${LEAD}/reveal`, 'POST'));
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(events).toEqual([
      'svc:profiles',
      'ops:pii-reveal',
      'rls:leads',
      'audit:lead.view_pii',
      'svc:leads',
    ]);
    expect(body.data).toEqual({
      email: 'sara@acme.sa',
      phone: '+966500000000',
      budget: 'gt_200k',
      timeline: 'Before Ramadan',
      timeline_band: null,
    });
    // The audit row names every field the response carries, and no other.
    expect([...(audits[0]!.detail!['fields'] as string[])].sort()).toEqual(
      Object.keys(body.data).sort(),
    );
  });

  it('spends a slot of the REVEAL limit (60 an hour), not the export one', async () => {
    await reveal.POST(ctx(`/api/admin/leads/${LEAD}/reveal`, 'POST'));
    expect(claimedLimits).toEqual([PII_REVEAL_LIMITS]);
  });

  it("the service-role read is this lead in the caller's tenant, nothing wider", async () => {
    await reveal.POST(ctx(`/api/admin/leads/${LEAD}/reveal`, 'POST'));
    const gated = filters.filter((f) => f['owner'] === 'svc' && f['table'] === 'leads');
    expect(gated).toEqual([{ owner: 'svc', table: 'leads', tenant_id: TENANT, id: LEAD }]);
  });

  it('over the limit: 429 and nothing read', async () => {
    limited = true;
    expect((await reveal.POST(ctx(`/api/admin/leads/${LEAD}/reveal`, 'POST'))).status).toBe(429);
    expect(events).toEqual(['svc:profiles', 'ops:pii-reveal']);
  });

  it('no audit row: 403 and nothing gated read', async () => {
    auditOk = false;
    expect((await reveal.POST(ctx(`/api/admin/leads/${LEAD}/reveal`, 'POST'))).status).toBe(403);
    expect(events).not.toContain('svc:leads');
  });
});

describe('the notes thread', () => {
  it('GET writes its audit row before the thread is read, and names authors', async () => {
    const res = await notes.GET(ctx(`/api/admin/leads/${LEAD}/notes`));
    const body = (await res.json()) as { data: { notes: Record<string, unknown>[] } };
    expect(res.status).toBe(200);
    expect(events.indexOf('audit:lead.view_notes')).toBeLessThan(
      events.indexOf('svc:list:lead_notes'),
    );
    expect(body.data.notes).toEqual([
      {
        id: NOTE,
        body: 'Sent the proposal',
        source: 'staff',
        created_at: 'x',
        author: { id: USER, display_name: 'Amal' },
      },
    ]);
    expect(filters.find((f) => f['table'] === 'lead_notes')).toMatchObject({
      owner: 'svc',
      tenant_id: TENANT,
      lead_id: LEAD,
    });
  });

  it('GET without an audit row: 403 and the thread is never read', async () => {
    auditOk = false;
    expect((await notes.GET(ctx(`/api/admin/leads/${LEAD}/notes`))).status).toBe(403);
    expect(events).not.toContain('svc:list:lead_notes');
  });

  it('POST is ONE insert, as the session user; the database writes its timeline event', async () => {
    const res = await notes.POST(
      ctx(`/api/admin/leads/${LEAD}/notes`, 'POST', { body: '  Called back  ' }),
    );
    expect(res.status).toBe(200);
    expect(inserts).toEqual([
      {
        table: 'lead_notes',
        row: {
          tenant_id: TENANT,
          lead_id: LEAD,
          body: 'Called back',
          source: 'staff',
          created_by: USER,
        },
      },
    ]);
  });

  it('POST whose insert fails is a 500, with nothing else written', async () => {
    noteInsertFails = true;
    const res = await notes.POST(ctx(`/api/admin/leads/${LEAD}/notes`, 'POST', { body: 'x' }));
    expect(res.status).toBe(500);
    expect(inserts.map((i) => i.table)).toEqual(['lead_notes']);
    expect(events.filter((e) => e.startsWith('audit:'))).toEqual([]);
  });

  it('POST refuses an empty note, or an author smuggled in', async () => {
    expect(
      (await notes.POST(ctx(`/api/admin/leads/${LEAD}/notes`, 'POST', { body: '   ' }))).status,
    ).toBe(422);
    expect(
      (
        await notes.POST(
          ctx(`/api/admin/leads/${LEAD}/notes`, 'POST', { body: 'x', created_by: 'someone' }),
        )
      ).status,
    ).toBe(422);
    expect(inserts).toHaveLength(0);
  });

  // §9(b): demotion, deactivation and a lock bite at once, before any thread read or write.
  for (const [name, profile] of [
    ['a demoted holder', { role: 'seo', is_active: true, locked_until: null }],
    ['a deactivated holder', { role: 'admin', is_active: false, locked_until: null }],
    ['a locked holder', { role: 'admin', is_active: true, locked_until: '2999-01-01T00:00:00Z' }],
  ] as const) {
    it(`${name} is refused (live recheck): 403, no thread read, no note`, async () => {
      liveProfile = { ...profile };
      expect((await notes.GET(ctx(`/api/admin/leads/${LEAD}/notes`))).status).toBe(403);
      expect(
        (await notes.POST(ctx(`/api/admin/leads/${LEAD}/notes`, 'POST', { body: 'x' }))).status,
      ).toBe(403);
      expect(events.some((e) => e.includes('lead_notes'))).toBe(false);
      expect(inserts).toHaveLength(0);
      expect(audits).toHaveLength(0);
    });
  }

  it("a lead the caller's RLS cannot see is a 404, before any audit row, read or write", async () => {
    rlsSeesLead = false;
    expect((await notes.GET(ctx(`/api/admin/leads/${LEAD}/notes`))).status).toBe(404);
    expect(
      (await notes.POST(ctx(`/api/admin/leads/${LEAD}/notes`, 'POST', { body: 'x' }))).status,
    ).toBe(404);
    expect(events.filter((e) => e.startsWith('rls:'))).toEqual(['rls:leads', 'rls:leads']);
    expect(events.some((e) => e.includes('lead_notes') || e.startsWith('audit:'))).toBe(false);
    expect(inserts).toHaveLength(0);
  });
});

describe('GET /[id]/events', () => {
  it('reads the timeline as the caller, scoped to the tenant and the lead', async () => {
    const res = await timeline.GET(ctx(`/api/admin/leads/${LEAD}/events?limit=1`));
    const body = (await res.json()) as {
      data: { events: { id: number }[]; before: string | null; beforeId: number | null };
    };
    expect(res.status).toBe(200);
    expect(body.data.events.map((e) => e.id)).toEqual([12]);
    // A full page: the next one starts after this EVENT, not after its instant.
    expect(body.data).toMatchObject({ before: T2, beforeId: 12 });
    expect(events).toContain('rls:list:lead_events');
    expect(filters.find((f) => f['table'] === 'lead_events')).toMatchObject({
      owner: 'rls',
      tenant_id: TENANT,
      lead_id: LEAD,
    });
  });

  it('pages through events that share an instant without dropping one', async () => {
    const seen: number[] = [];
    let query = 'limit=1';
    for (let page = 0; page < 5; page += 1) {
      const res = await timeline.GET(ctx(`/api/admin/leads/${LEAD}/events?${query}`));
      const body = (await res.json()) as {
        data: { events: { id: number }[]; before: string | null; beforeId: number | null };
      };
      seen.push(...body.data.events.map((e) => e.id));
      if (body.data.before === null) break;
      query = new URLSearchParams({
        limit: '1',
        before: body.data.before,
        beforeId: String(body.data.beforeId),
      }).toString();
    }
    expect(seen).toEqual([12, 11, 10]);
  });

  it('refuses a malformed page, or half a cursor', async () => {
    expect((await timeline.GET(ctx(`/api/admin/leads/${LEAD}/events?limit=500`))).status).toBe(422);
    expect(
      (await timeline.GET(ctx(`/api/admin/leads/${LEAD}/events?before=${encodeURIComponent(T2)}`)))
        .status,
    ).toBe(422);
    expect((await timeline.GET(ctx(`/api/admin/leads/${LEAD}/events?beforeId=0`))).status).toBe(
      422,
    );
  });
});
