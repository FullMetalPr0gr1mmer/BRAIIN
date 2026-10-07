import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIContext } from 'astro';

// One lead in the CRM (Admin v2 C2b): the reveal returns contact details only, after the
// limiter and a written audit row; the notes thread opens only after its own written audit
// row, and a note's author is the session's user; the timeline is read as the caller.

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';
const LEAD = '22222222-2222-4222-8222-222222222222';
const NOTE = '33333333-3333-4333-8333-333333333333';

let auditOk = true;
let limited = false;
const events: string[] = [];
const inserts: { table: string; row: Record<string, unknown> }[] = [];
const filters: Record<string, unknown>[] = [];

vi.mock('@/lib/admin/audit', () => ({
  writeAudit: async (_sb: unknown, _auth: unknown, entry: { action: string }) => {
    events.push(`audit:${entry.action}`);
    return auditOk;
  },
}));
vi.mock('@/lib/crypto/pii', () => ({
  decryptPII: async (v: string) => v.replace(/^enc:/, ''),
}));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));
vi.mock('@/lib/admin/rateLimit', async () => {
  const { RateLimitError } = await import('@/lib/admin/errors');
  return {
    PII_REVEAL_LIMITS: { perUser: 60, perTenant: 300, windowMinutes: 60 },
    claimPrivilegedOp: async (_a: unknown, op: string) => {
      events.push(`ops:${op}`);
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

/** A chainable stand-in recording what it was asked. */
function builder(table: string, owner: 'svc' | 'rls') {
  const f: Record<string, unknown> = {};
  const b: Record<string, unknown> = {};
  b['select'] = () => b;
  b['order'] = () => b;
  b['limit'] = () => b;
  b['lt'] = (column: string, value: unknown) => {
    f[`lt:${column}`] = value;
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
  b['single'] = async () => ({
    data: { id: NOTE, created_at: '2026-10-05T10:00:00Z' },
    error: null,
  });
  b['maybeSingle'] = async () => {
    events.push(`${owner}:${table}`);
    filters.push({ table, ...f });
    if (table === 'profiles')
      return { data: { role: 'admin', is_active: true, locked_until: null }, error: null };
    if (table === 'leads' && owner === 'svc') return { data: GATED, error: null };
    return { data: { id: LEAD, name: 'Sara' }, error: null };
  };
  b['then'] = (ok: (v: unknown) => unknown) => {
    events.push(`${owner}:list:${table}`);
    filters.push({ table, ...f });
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
            ? [{ id: 1, at: '2026-10-05T09:00:00Z', actor_id: null, kind: 'created', detail: {} }]
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

beforeEach(() => {
  auditOk = true;
  limited = false;
  events.length = 0;
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
    // The gated read was this lead in this tenant, nothing wider.
    expect(
      filters.find((f) => f['table'] === 'leads' && 'tenant_id' in f && f['id'] === LEAD),
    ).toBeTruthy();
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
});

describe('GET /[id]/events', () => {
  it('reads the timeline as the caller, scoped to the tenant and the lead', async () => {
    const res = await timeline.GET(ctx(`/api/admin/leads/${LEAD}/events?limit=1`));
    const body = (await res.json()) as { data: { events: unknown[]; before: string | null } };
    expect(res.status).toBe(200);
    expect(body.data.events).toHaveLength(1);
    // A full page: the next page starts before this event.
    expect(body.data.before).toBe('2026-10-05T09:00:00Z');
    expect(events).toContain('rls:list:lead_events');
    expect(filters.find((f) => f['table'] === 'lead_events')).toMatchObject({
      tenant_id: TENANT,
      lead_id: LEAD,
    });
  });

  it('refuses a malformed page', async () => {
    expect((await timeline.GET(ctx(`/api/admin/leads/${LEAD}/events?limit=500`))).status).toBe(422);
  });
});
