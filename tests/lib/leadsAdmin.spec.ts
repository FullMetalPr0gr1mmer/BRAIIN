import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIContext } from 'astro';
import { LEGACY_LEAD_COLUMNS } from '@/lib/admin/leadFields';
import { replayLeadGrant } from './leadGrantReplay';

// The lead detail route, past assertCap: the safe read and the pipeline PATCH. Until Admin v2
// C14a its GET also answered `?pii=1`, the legacy panel's contact-details reveal; C14a removed
// that alias, and these tests prove it is gone: `?pii=1` answers the safe row, spends no reveal
// slot, writes no `lead.view_pii` row, reads nothing as the service role and decrypts nothing.
// The one reveal is POST /api/admin/leads/[id]/reveal (tests/lib/leadDetailApi.spec.ts).
//
// Since migration 0033 a staff token can read only the safe lead columns. The caller's
// client below enforces that the way PostgREST would (42501 for any other column), so
// these tests also prove the route never asks it for a gated one. It can also stand in for
// the schema C14b leaves (`schema = 'c14b'`): the legacy columns gone, so a query naming one
// is a 42703, as PostgREST would answer it. Every test runs on both.

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';
const LEAD = '22222222-2222-4222-8222-222222222222';

/**
 * The columns `authenticated` may SELECT on leads, replayed from the migrations (0033 and
 * every grant since): the stand-in for PostgREST refuses any other column, as it would.
 */
const GRANTED = replayLeadGrant('select');

/** The columns C14b drops (docs/admin-v2/as-built/C14a.md, Notes for C14b). */
const DROPPED: readonly string[] = LEGACY_LEAD_COLUMNS;
let schema: 'today' | 'c14b' = 'today';

let auditOk = true;
let liveRole = 'admin';
let rlsSeesLead = true;
let revealLimited = false;
const events: string[] = [];
const audits: { action: string; detail?: Record<string, unknown> }[] = [];
const claimedLimits: unknown[] = [];
const serviceFilters: Record<string, unknown>[] = [];
const row: Record<string, unknown> = {
  id: LEAD,
  tenant_id: TENANT,
  kind: 'contact',
  locale: 'en',
  name: 'Sara',
  company: 'Acme',
  message: 'Hello',
  service_of_interest: 'logo',
  status: 'new',
  consent_marketing: true,
  created_at: '2026-10-01T10:00:00Z',
  updated_at: '2026-10-01T10:00:00Z',
  discipline_of_interest: null,
  email_enc: 'enc:sara@example.com',
  phone_enc: 'enc:+966500000000',
  budget_enc: 'enc:b25_75',
  timeline_band: '1-3m',
  timeline_text_enc: 'enc:Before Ramadan',
  internal_notes: 'Called back on Monday',
  ip_inet: null,
  // The pipeline (0034 to 0041), which the detail GET answers since C4a.
  lead_number: 12,
  stage_id: '33333333-3333-4333-8333-333333333333',
  is_spam: false,
  version: 3,
  score: 40,
  source: 'web_form',
  channel: 'unknown',
  assigned_to: USER,
  value_sar: 50000,
  is_starred: true,
  read_at: null,
  tags: ['VIP'],
  last_contact_at: null,
  last_contact_channel: null,
  // Gated (0035): the legacy reveal never returns it.
  score_signals: ['budget_given'],
};

const project = (select: string) =>
  Object.fromEntries(select.split(',').map((column) => [column, row[column]]));

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
  decryptPII: async (v: string) => {
    events.push('decrypt');
    return v.replace(/^enc:/, '');
  },
}));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));
// The reveal limiter (C2b): the real module with only the ledger call replaced, recorded in
// order with the limits it was given; can refuse like the real ledger.
vi.mock('@/lib/admin/rateLimit', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/admin/rateLimit')>('@/lib/admin/rateLimit');
  const { RateLimitError } = await import('@/lib/admin/errors');
  return {
    ...actual,
    claimPrivilegedOp: async (_auth: unknown, op: string, limits?: unknown) => {
      events.push(`ops:${op}`);
      claimedLimits.push(limits);
      if (revealLimited) throw new RateLimitError(`${op}:user`);
    },
  };
});
vi.mock('@/lib/leads/interestLabel', () => ({
  resolveLeadInterests: async () => new Map(),
  withInterestLabels: (r: Record<string, unknown>) => r,
}));
// The service role: the live recheck reads `profiles`; the reveal reads the gated lead
// columns. It bypasses RLS, so the route must scope it (the filters are recorded).
vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({
    from: (table: string) => {
      let select = '';
      const filters: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};
      b['select'] = (columns: string) => {
        select = columns;
        return b;
      };
      b['eq'] = (column: string, value: unknown) => {
        filters[column] = value;
        return b;
      };
      b['maybeSingle'] = async () => {
        events.push(`svc:${table}`);
        if (table === 'profiles') {
          return { data: { role: liveRole, is_active: true, locked_until: null }, error: null };
        }
        serviceFilters.push(filters);
        return { data: project(select), error: null };
      };
      return b;
    },
  }),
}));

/** The caller's client: RLS decides the row, the 0033 column grant decides the columns. */
function rlsClient() {
  return {
    from: () => {
      let select = '';
      let patch: Record<string, unknown> | null = null;
      const b: Record<string, unknown> = {};
      b['select'] = (columns: string) => {
        select = columns;
        return b;
      };
      b['update'] = (values: Record<string, unknown>) => {
        patch = values;
        return b;
      };
      b['eq'] = () => b;
      b['maybeSingle'] = async () => {
        const missing = select.split(',').filter((c) => schema === 'c14b' && DROPPED.includes(c));
        if (missing.length > 0) {
          events.push(`rls:undefined:${missing.join(',')}`);
          return {
            data: null,
            error: { code: '42703', message: `column leads.${missing[0]} does not exist` },
          };
        }
        const refused = select.split(',').filter((column) => !GRANTED.has(column));
        if (refused.length > 0) {
          events.push(`rls:refused:${refused.join(',')}`);
          return {
            data: null,
            error: { code: '42501', message: 'permission denied for table leads' },
          };
        }
        events.push(patch ? 'rls:update' : 'rls:select');
        return { data: rlsSeesLead ? project(select) : null, error: null };
      };
      return b;
    },
  };
}

function ctx(path: string, role = 'admin', init?: { method: string; body: unknown }): APIContext {
  const url = new URL(`https://www.braiinstation.com${path}`);
  return {
    request: new Request(url, {
      method: init?.method ?? 'GET',
      ...(init
        ? { body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } }
        : {}),
    }),
    url,
    params: { id: LEAD },
    locals: {
      session: { userId: USER, tenantId: TENANT, role, email: 'a@x', isActive: true },
      supabase: rlsClient(),
    },
  } as unknown as APIContext;
}

const detail = await import('@/pages/api/admin/leads/[id]');

beforeEach(() => {
  schema = 'today';
  auditOk = true;
  liveRole = 'admin';
  rlsSeesLead = true;
  revealLimited = false;
  events.length = 0;
  audits.length = 0;
  claimedLimits.length = 0;
  serviceFilters.length = 0;
});

// Admin v2 C14a: the legacy panel's reveal alias is gone. The query string is not read at all,
// so `?pii=1` is the plain safe view: no limiter slot, no `lead.view_pii` row, no service-role
// read, no decrypt, no contact detail, no legacy field, for every role that may see the lead.
describe.each(['today', 'c14b'] as const)(
  'the ?pii=1 alias is gone (C14a), %s schema',
  (onSchema) => {
    beforeEach(() => {
      schema = onSchema;
    });

    it.each(['admin', 'developer', 'sales'] as const)(
      '%s asking ?pii=1 gets the safe row, and nothing is revealed',
      async (role) => {
        liveRole = role;
        const res = await detail.GET(ctx(`/api/admin/leads/${LEAD}?pii=1`, role));
        const body = (await res.json()) as { data: Record<string, unknown> };
        expect(res.status).toBe(200);
        expect(events).toEqual(['rls:select', 'audit:lead.view']);
        expect(audits).toEqual([expect.objectContaining({ action: 'lead.view' })]);
        expect(claimedLimits).toEqual([]);
        expect(serviceFilters).toEqual([]);
        expect(body.data['name']).toBe('Sara');
        for (const hidden of [
          'email',
          'phone',
          'budget',
          'timeline',
          ...DROPPED,
          'email_enc',
          'phone_enc',
          'budget_enc',
          'timeline_text_enc',
          'score_signals',
        ]) {
          expect(body.data[hidden], hidden).toBeUndefined();
        }
        expect(JSON.stringify(body)).not.toContain('sara@example.com');
        expect(JSON.stringify(body)).not.toContain('Called back');
      },
    );

    it('answers the same with or without the parameter', async () => {
      const plain = (await (await detail.GET(ctx(`/api/admin/leads/${LEAD}`))).json()) as unknown;
      const asked = (await (
        await detail.GET(ctx(`/api/admin/leads/${LEAD}?pii=1`))
      ).json()) as unknown;
      expect(asked).toEqual(plain);
    });
  },
);

describe.each(['today', 'c14b'] as const)('lead detail on %s schema', (onSchema) => {
  beforeEach(() => {
    schema = onSchema;
  });

  it('returns safe columns only, decrypts nothing, and logs a plain view', async () => {
    const res = await detail.GET(ctx(`/api/admin/leads/${LEAD}`));
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(events).toEqual(['rls:select', 'audit:lead.view']);
    expect(body.data['name']).toBe('Sara');
    for (const hidden of ['email_enc', 'phone_enc', 'budget_enc', 'score_signals', ...DROPPED]) {
      expect(body.data[hidden], hidden).toBeUndefined();
    }
  });

  it('answers the pipeline columns too (C4a), through the column grant', async () => {
    const res = await detail.GET(ctx(`/api/admin/leads/${LEAD}`));
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(events.some((e) => e.startsWith('rls:refused'))).toBe(false);
    expect(body.data).toMatchObject({
      lead_number: 12,
      version: 3,
      assigned_to: USER,
      value_sar: 50000,
      is_starred: true,
      tags: ['VIP'],
      source: 'web_form',
    });
  });
});

describe.each(['today', 'c14b'] as const)('saving a lead on %s schema', (onSchema) => {
  beforeEach(() => {
    schema = onSchema;
  });

  it('an unversioned save reads nothing back but the safe columns, nothing gated', async () => {
    const res = await detail.PATCH(
      ctx(`/api/admin/leads/${LEAD}`, 'admin', {
        method: 'PATCH',
        body: { isStarred: true },
      }),
    );
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(events.some((e) => e.startsWith('rls:refused'))).toBe(false);
    expect(events).not.toContain('svc:leads');
    expect(events).toContain('rls:update');
    expect(body.data['name']).toBe('Sara');
    for (const legacy of DROPPED) expect(body.data[legacy], legacy).toBeUndefined();
    expect(body.data['email_enc']).toBeUndefined();
  });

  it.each(['developer', 'sales'] as const)(
    'a read-mark save by %s reads nothing gated either',
    async (role) => {
      liveRole = role;
      const res = await detail.PATCH(
        ctx(`/api/admin/leads/${LEAD}`, role, { method: 'PATCH', body: { read: true } }),
      );
      expect(res.status).toBe(200);
      expect(events.some((e) => e.startsWith('rls:refused'))).toBe(false);
      expect(events).not.toContain('svc:leads');
    },
  );
});
