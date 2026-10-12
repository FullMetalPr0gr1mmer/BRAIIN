import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIContext } from 'astro';
import { replayLeadGrant } from './leadGrantReplay';

// The lead detail route, past assertCap: the contact-details reveal must be audited
// BEFORE anything is decrypted, and refused when the audit row cannot be written
// (CLAUDE.md §3: "audit-log every view"; PDPL accountability). The kernel's queued
// audit runs after the handler and cannot stop a response, so the reveal writes its
// row directly, as the job-applications reveal does. Also covers the notes editor,
// which must not appear before the reveal or it would save an empty value over the
// real notes.
//
// Since migration 0033 a staff token can read only the safe lead columns. The caller's
// client below enforces that the way PostgREST would (42501 for any other column), so
// these tests also prove the route never asks it for a gated one: the reveal reads them
// as the service role, after the RLS read, the live recheck and the audit row.

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';
const LEAD = '22222222-2222-4222-8222-222222222222';

/**
 * The columns `authenticated` may SELECT on leads, replayed from the migrations (0033 and
 * every grant since): the stand-in for PostgREST refuses any other column, as it would.
 */
const GRANTED = replayLeadGrant('select');

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
const { afterSave, saveLead, showNotesEditor } =
  await import('@/components/admin/screens/leads/LeadsPanel');
const { PII_REVEAL_LIMITS } = await import('@/lib/admin/rateLimit');

beforeEach(() => {
  auditOk = true;
  liveRole = 'admin';
  rlsSeesLead = true;
  revealLimited = false;
  events.length = 0;
  audits.length = 0;
  claimedLimits.length = 0;
  serviceFilters.length = 0;
});

describe('lead contact details (?pii=1)', () => {
  it('recheck, rate limit, RLS read, audit row, THEN the gated columns and decrypt; never ciphertext', async () => {
    const res = await detail.GET(ctx(`/api/admin/leads/${LEAD}?pii=1`));
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(events.slice(0, 5)).toEqual([
      'svc:profiles',
      'ops:pii-reveal',
      'rls:select',
      'audit:lead.view_pii',
      'svc:leads',
    ]);
    expect(events.slice(5).every((e) => e === 'decrypt')).toBe(true);
    expect(events.filter((e) => e.startsWith('audit:'))).toEqual(['audit:lead.view_pii']);
    expect(body.data['email']).toBe('sara@example.com');
    expect(body.data['phone']).toBe('+966500000000');
    expect(body.data['timeline']).toBe('Before Ramadan');
    // Gated but not encrypted: returned as stored, to a leads.pii holder.
    expect(body.data['internal_notes']).toBe('Called back on Monday');
    expect(body.data['timeline_band']).toBe('1-3m');
    expect(body.data['name']).toBe('Sara');
    for (const ciphertext of ['email_enc', 'phone_enc', 'budget_enc', 'timeline_text_enc']) {
      expect(body.data[ciphertext], ciphertext).toBeUndefined();
    }
  });

  it("reads the gated columns for this one lead in the caller's tenant only", async () => {
    await detail.GET(ctx(`/api/admin/leads/${LEAD}?pii=1`));
    expect(serviceFilters).toEqual([{ tenant_id: TENANT, id: LEAD }]);
  });

  it('the audit row names every gated field the response carries (notes and IP too)', async () => {
    const res = await detail.GET(ctx(`/api/admin/leads/${LEAD}?pii=1`));
    const body = (await res.json()) as { data: Record<string, unknown> };
    const disclosed = [
      'email',
      'phone',
      'budget',
      'timeline',
      'timeline_band',
      'internal_notes',
      'ip_inet',
    ].filter((field) => field in body.data);
    expect(disclosed).toHaveLength(7);
    expect([...(audits[0]!.detail!['fields'] as string[])].sort()).toEqual(disclosed.sort());
  });

  it('spends a slot of the REVEAL limit (60 an hour), not the export one', async () => {
    await detail.GET(ctx(`/api/admin/leads/${LEAD}?pii=1`));
    expect(claimedLimits).toEqual([PII_REVEAL_LIMITS]);
  });

  it("never asks the caller's client for a gated column", async () => {
    await detail.GET(ctx(`/api/admin/leads/${LEAD}?pii=1`));
    expect(events.some((e) => e.startsWith('rls:refused'))).toBe(false);
  });

  it('refuses, and reads and decrypts nothing gated, when the audit row cannot be written', async () => {
    auditOk = false;
    const res = await detail.GET(ctx(`/api/admin/leads/${LEAD}?pii=1`));
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(403);
    expect(events).not.toContain('svc:leads');
    expect(events).not.toContain('decrypt');
    expect(JSON.stringify(body)).not.toContain('sara@example.com');
    expect(JSON.stringify(body)).not.toContain('Called back');
  });

  it("a lead the caller's RLS cannot see is a 404, before any audit or gated read", async () => {
    rlsSeesLead = false;
    const res = await detail.GET(ctx(`/api/admin/leads/${LEAD}?pii=1`));
    expect(res.status).toBe(404);
    expect(events).toEqual(['svc:profiles', 'ops:pii-reveal', 'rls:select']);
  });

  it('the 61st reveal in an hour is a 429, before any read, audit or decrypt (C2b)', async () => {
    revealLimited = true;
    const res = await detail.GET(ctx(`/api/admin/leads/${LEAD}?pii=1`));
    expect(res.status).toBe(429);
    expect(events).toEqual(['svc:profiles', 'ops:pii-reveal']);
  });

  it('a demoted user is refused at once (live recheck), before any read, audit or decrypt', async () => {
    liveRole = 'seo';
    const res = await detail.GET(ctx(`/api/admin/leads/${LEAD}?pii=1`));
    expect(res.status).toBe(403);
    expect(events).toEqual(['svc:profiles']);
  });

  it('Developer holds leads.pii and gets the same audited reveal', async () => {
    liveRole = 'developer';
    const res = await detail.GET(ctx(`/api/admin/leads/${LEAD}?pii=1`, 'developer'));
    expect(res.status).toBe(200);
    expect(events.slice(0, 5)).toEqual([
      'svc:profiles',
      'ops:pii-reveal',
      'rls:select',
      'audit:lead.view_pii',
      'svc:leads',
    ]);
  });
});

describe('lead detail without the reveal', () => {
  it('returns safe columns only, decrypts nothing, and logs a plain view', async () => {
    const res = await detail.GET(ctx(`/api/admin/leads/${LEAD}`));
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(events).toEqual(['rls:select', 'audit:lead.view']);
    expect(body.data['name']).toBe('Sara');
    for (const hidden of ['email_enc', 'phone_enc', 'budget_enc', 'internal_notes', 'ip_inet']) {
      expect(body.data[hidden], hidden).toBeUndefined();
    }
  });
});

describe('saving a lead', () => {
  it('writes notes without reading them back: the safe columns return, nothing gated', async () => {
    const res = await detail.PATCH(
      ctx(`/api/admin/leads/${LEAD}`, 'admin', {
        method: 'PATCH',
        body: { status: 'in_progress', internalNotes: 'Sent the proposal' },
      }),
    );
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(events.some((e) => e.startsWith('rls:refused'))).toBe(false);
    expect(events).not.toContain('svc:leads');
    expect(events).toContain('rls:update');
    expect(body.data['name']).toBe('Sara');
    expect(body.data['internal_notes']).toBeUndefined();
    expect(body.data['email_enc']).toBeUndefined();
  });

  it('a status-only save by Developer reads nothing gated either', async () => {
    liveRole = 'developer';
    const res = await detail.PATCH(
      ctx(`/api/admin/leads/${LEAD}`, 'developer', { method: 'PATCH', body: { status: 'done' } }),
    );
    expect(res.status).toBe(200);
    expect(events.some((e) => e.startsWith('rls:refused'))).toBe(false);
    expect(events).not.toContain('svc:leads');
  });
});

describe('the notes editor', () => {
  it('appears only after the audited reveal, so a save can never blank the real notes', () => {
    expect(showNotesEditor(true, false)).toBe(false);
    expect(showNotesEditor(true, true)).toBe(true);
    expect(showNotesEditor(false, true)).toBe(false);
    expect(showNotesEditor(false, false)).toBe(false);
  });
});

describe('after a save, the panel', () => {
  const open = {
    id: LEAD,
    name: 'Sara',
    status: 'new',
    service_of_interest: 'logo',
    locale: 'en',
    created_at: '2026-10-01T10:00:00Z',
    message: 'Hello',
    email: 'sara@example.com',
    phone: '+966500000000',
    internal_notes: 'Called back on Monday',
  };
  // What PATCH answers: the safe columns only.
  const answer = {
    id: LEAD,
    name: 'Sara',
    status: 'in_progress',
    service_of_interest: 'logo',
    locale: 'en',
    created_at: '2026-10-01T10:00:00Z',
    message: 'Hello',
  };

  it('keeps the details it already revealed and shows the saved notes: no second reveal', () => {
    const next = afterSave(
      open,
      LEAD,
      { status: 'in_progress', name: 'Sara' },
      {
        internalNotes: 'Sent the proposal',
      },
    );
    expect(next).toMatchObject({
      status: 'in_progress',
      email: 'sara@example.com',
      phone: '+966500000000',
      internal_notes: 'Sent the proposal',
    });
    expect(afterSave(open, 'another-lead', { status: 'done' }, {})).toBe(open);
    expect(afterSave(null, LEAD, { status: 'done' }, {})).toBeNull();
  });

  it('reports a save that stood as saved, even when the list cannot be refreshed', async () => {
    const outcome = await saveLead(
      LEAD,
      { status: 'in_progress' },
      {
        save: async () => ({ ...answer }),
        refresh: async () => {
          throw new Error('Rate limit exceeded');
        },
      },
    );
    expect(outcome.error).toBe('');
    expect(outcome.saved).toMatchObject({ status: 'in_progress' });
    expect(outcome.notice).toMatch(/^Saved\./);
  });

  it('reports a save that failed as an error, and refreshes nothing', async () => {
    let refreshed = false;
    const outcome = await saveLead(
      LEAD,
      { status: 'in_progress' },
      {
        save: async () => {
          throw new Error('That item no longer exists.');
        },
        refresh: async () => {
          refreshed = true;
        },
      },
    );
    expect(outcome).toEqual({ saved: null, error: 'That item no longer exists.', notice: '' });
    expect(refreshed).toBe(false);
  });
});
