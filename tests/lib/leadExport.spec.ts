import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIRoute } from 'astro';

// The lead CSV export since Admin v2 C3: the list's filters that may sit in a link (stage,
// spam, a date range; never the search), the pipeline's columns (number, stage, spam,
// assignee, value, tags, score, source, channel), note COUNTS instead of note bodies, and
// a read paged in PostgREST's 1,000-row pages so the 5,000 cap is real.

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';
const STAGE = '55555555-5555-4555-8555-555555555555';
const PERSON = '66666666-6666-4666-8666-666666666666';

const calls: { owner: string; table: string; method: string; args: unknown[] }[] = [];
const rpcs: { owner: string; fn: string; args: Record<string, unknown> }[] = [];
let pages: Record<string, unknown>[][] = [];

function recorder(owner: string, table: string) {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'lte', 'in', 'order', 'limit', 'range']) {
    b[m] = (...args: unknown[]) => {
      calls.push({ owner, table, method: m, args });
      return b;
    };
  }
  b['then'] = (ok: (v: unknown) => unknown) => {
    let data: unknown = [];
    if (table === 'leads') data = pages.shift() ?? [];
    if (table === 'lead_stages') data = [{ id: STAGE, label: 'Proposal sent' }];
    return Promise.resolve({ data, error: null }).then(ok);
  };
  return b;
}

function rpcFor(owner: string) {
  return async (fn: string, args: Record<string, unknown>) => {
    rpcs.push({ owner, fn, args });
    if (fn === 'crm_people') return { data: [{ id: PERSON, display_name: 'Amal' }], error: null };
    if (fn === 'crm_lead_note_counts') return { data: { l1: 3 }, error: null };
    return { data: null, error: null };
  };
}

vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({ from: (t: string) => recorder('svc', t), rpc: rpcFor('svc') }),
}));
vi.mock('@/lib/admin/liveRecheck', () => ({ liveRecheck: async () => undefined }));
vi.mock('@/lib/admin/rateLimit', () => ({ claimPrivilegedOp: async () => undefined }));
vi.mock('@/lib/admin/audit', () => ({ writeAudit: async () => true }));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));
vi.mock('@/lib/crypto/pii', () => ({ decryptPII: async (v: string) => v.replace(/^enc:/, '') }));
vi.mock('@/lib/leads/interestLabel', () => ({
  resolveLeadInterests: async () => new Map(),
  withInterestLabels: (r: Record<string, unknown>) => r,
}));

const { GET } = await import('@/pages/api/admin/leads/export');

function call(query = '') {
  const url = new URL(`https://admin.example.test/api/admin/leads/export${query}`);
  return (GET as APIRoute)({
    request: new Request(url),
    url,
    params: {},
    locals: {
      session: { userId: USER, tenantId: TENANT, role: 'admin', isActive: true, email: 'x@x' },
      supabase: { from: (t: string) => recorder('rls', t), rpc: rpcFor('rls') },
      cspNonce: 'n',
      csrfToken: 'c',
    },
  } as unknown as Parameters<APIRoute>[0]) as Promise<Response>;
}

const ROW = {
  id: 'l1',
  lead_number: 7,
  created_at: '2026-10-01T10:00:00Z',
  status: 'in_progress',
  stage_id: STAGE,
  is_spam: false,
  name: 'Sara',
  company: 'Acme',
  message: 'Hello',
  locale: 'en',
  assigned_to: PERSON,
  value_sar: 50000,
  tags: ['VIP', 'Urgent'],
  score: 40,
  source: 'manual',
  channel: 'phone',
  email_enc: 'enc:sara@acme.sa',
  internal_notes: 'never exported',
};

beforeEach(() => {
  calls.length = 0;
  rpcs.length = 0;
  pages = [[ROW]];
});

/** One CSV line's cells: quoted ones may hold commas, empty ones are bare (toCsv). */
function cells(line: string): string[] {
  return [...line.replace(/^﻿/, '').matchAll(/(?:^|,)(?:"((?:[^"]|"")*)"|([^,]*))/g)].map((m) =>
    (m[1] ?? m[2] ?? '').replace(/""/g, '"'),
  );
}

describe('the lead export (C3)', () => {
  it('applies the stage, spam and date filters on the service-role read, for this tenant', async () => {
    const res = await call(
      `?stage=${STAGE}&spam=false&from=2026-10-01T00:00:00Z&to=2026-10-09T00:00:00Z`,
    );
    expect(res.status).toBe(200);
    const filters = calls.filter((c) => c.owner === 'svc' && c.table === 'leads');
    for (const expected of [
      ['eq', ['tenant_id', TENANT]],
      ['eq', ['stage_id', STAGE]],
      ['eq', ['is_spam', false]],
      ['gte', ['created_at', '2026-10-01T00:00:00Z']],
      ['lte', ['created_at', '2026-10-09T00:00:00Z']],
    ] as const) {
      expect(filters).toContainEqual({
        owner: 'svc',
        table: 'leads',
        method: expected[0],
        args: expected[1],
      });
    }
  });

  it('never reads note bodies or the address, and exports a note count instead', async () => {
    const res = await call();
    const select = calls.find((c) => c.table === 'leads' && c.method === 'select')!;
    const columns = String(select.args[0]).split(',');
    expect(columns).not.toContain('internal_notes');
    expect(columns).not.toContain('ip_inet');
    expect(columns).toEqual(expect.arrayContaining(['stage_id', 'assigned_to', 'tags', 'score']));
    const [header, first] = (await res.text()).trim().split(/\r?\n/);
    const head = cells(header!);
    const row = cells(first!);
    expect(head).not.toContain('internal_notes');
    expect(row[head.indexOf('notes_count')]).toBe('3');
    expect(row[head.indexOf('stage')]).toBe('Proposal sent');
    expect(row[head.indexOf('assignee')]).toBe('Amal');
    expect(row[head.indexOf('tags')]).toBe('VIP, Urgent');
    expect(row[head.indexOf('lead_number')]).toBe('7');
    expect(row[head.indexOf('email')]).toBe('sara@acme.sa');
    expect(rpcs.find((r) => r.fn === 'crm_lead_note_counts')).toEqual({
      owner: 'svc',
      fn: 'crm_lead_note_counts',
      args: { p_tenant: TENANT, p_leads: ['l1'] },
    });
  });

  it('reads in pages of 1,000 until a short page, so the cap is not the API row limit', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({ ...ROW, id: `a${i}` }));
    pages = [full, full, [ROW]];
    const res = await call();
    expect(res.status).toBe(200);
    const ranges = calls.filter((c) => c.table === 'leads' && c.method === 'range');
    expect(ranges.map((c) => c.args)).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it('refuses a search term in the link (it would sit in history and logs)', async () => {
    expect((await call('?q=sara%40acme.sa')).status).toBe(422);
    expect(calls.filter((c) => c.table === 'leads')).toEqual([]);
  });
});
