import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIRoute } from 'astro';

// The lead CSV export since Admin v2 C3: the list's filters that may sit in a link (stage,
// spam, a date range; never the search) with the list's defaults (no spam unless asked, `to`
// exclusive), the pipeline's columns (number, stage, spam, assignee, value, tags, score,
// source, channel), note COUNTS instead of note bodies, and a keyset-paged read whose cap is
// real and which says when it stopped short.

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';
const STAGE = '55555555-5555-4555-8555-555555555555';
const PERSON = '66666666-6666-4666-8666-666666666666';
const LEAD = '77777777-7777-4777-8777-777777777777';

const calls: { owner: string; table: string; method: string; args: unknown[]; page: number }[] = [];
const rpcs: { owner: string; fn: string; args: Record<string, unknown> }[] = [];
const audits: { action: string; detail?: Record<string, unknown> }[] = [];
let pages: Record<string, unknown>[][] = [];
let leadReads = 0;

function recorder(owner: string, table: string) {
  const b: Record<string, unknown> = {};
  const page = table === 'leads' ? leadReads++ : -1;
  for (const m of ['select', 'eq', 'gte', 'lte', 'lt', 'or', 'in', 'order', 'limit', 'range']) {
    b[m] = (...args: unknown[]) => {
      calls.push({ owner, table, method: m, args, page });
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
    if (fn === 'crm_lead_note_counts') return { data: { [LEAD]: 3 }, error: null };
    return { data: null, error: null };
  };
}

vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({ from: (t: string) => recorder('svc', t), rpc: rpcFor('svc') }),
}));
vi.mock('@/lib/admin/liveRecheck', () => ({ liveRecheck: async () => undefined }));
vi.mock('@/lib/admin/rateLimit', () => ({ claimPrivilegedOp: async () => undefined }));
vi.mock('@/lib/admin/audit', () => ({
  writeAudit: async (_sb: unknown, _auth: unknown, entry: (typeof audits)[number]) => {
    audits.push(entry);
    return true;
  },
}));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));
vi.mock('@/lib/crypto/pii', () => ({ decryptPII: async (v: string) => v.replace(/^enc:/, '') }));
vi.mock('@/lib/leads/interestLabel', () => ({
  resolveLeadInterests: async () => new Map(),
  withInterestLabels: (r: Record<string, unknown>) => r,
}));

const { GET } = await import('@/pages/api/admin/leads/export');
const { MAX_EXPORT_ROWS, MAX_PAGES, PAGE_ROWS } = await import('@/lib/crm/exportRead');

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
  id: LEAD,
  lead_number: 7,
  created_at: '2026-10-01T10:00:00.123456+00:00',
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

/** `n` distinct leads, newest first, each a minute older than the one before. */
function leads(n: number, from = 0): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => {
    const k = from + i;
    return {
      ...ROW,
      id: `00000000-0000-4000-8000-${String(k).padStart(12, '0')}`,
      lead_number: 100000 - k,
      created_at: new Date(Date.UTC(2026, 9, 1, 12) - k * 60_000).toISOString(),
    };
  });
}

const leadCalls = () => calls.filter((c) => c.table === 'leads');
const onPage = (page: number, method: string) =>
  leadCalls().filter((c) => c.page === page && c.method === method);
const outcome = () => audits.find((a) => a.action === 'export.csv.outcome')!.detail!;

beforeEach(() => {
  calls.length = 0;
  rpcs.length = 0;
  audits.length = 0;
  leadReads = 0;
  pages = [[ROW]];
});

/** One CSV line's cells: quoted ones may hold commas, empty ones are bare (toCsv). */
function cells(line: string): string[] {
  return [...line.replace(/^﻿/, '').matchAll(/(?:^|,)(?:"((?:[^"]|"")*)"|([^,]*))/g)].map((m) =>
    (m[1] ?? m[2] ?? '').replace(/""/g, '"'),
  );
}

describe('the lead export (C3): filters', () => {
  it('applies the stage, spam and date filters on the service-role read, for this tenant', async () => {
    const res = await call(
      `?stage=${STAGE}&spam=false&from=2026-10-01T00:00:00Z&to=2026-10-09T00:00:00Z`,
    );
    expect(res.status).toBe(200);
    const filters = leadCalls().filter((c) => c.owner === 'svc');
    for (const expected of [
      ['eq', ['tenant_id', TENANT]],
      ['eq', ['stage_id', STAGE]],
      ['eq', ['is_spam', false]],
      ['gte', ['created_at', '2026-10-01T00:00:00Z']],
      ['lt', ['created_at', '2026-10-09T00:00:00Z']],
    ] as const) {
      expect(filters).toContainEqual(
        expect.objectContaining({ owner: 'svc', method: expected[0], args: expected[1] }),
      );
    }
  });

  it('`to` is exclusive, as on the list: a lead at that instant belongs to the next range', async () => {
    await call('?to=2026-10-09T00:00:00Z');
    expect(leadCalls().filter((c) => c.method === 'lte')).toEqual([]);
    expect(onPage(0, 'lt')[0]!.args).toEqual(['created_at', '2026-10-09T00:00:00Z']);
  });

  it('leaves spam out unless asked, as the list does', async () => {
    const spamFilter = async (query: string) => {
      calls.length = 0;
      leadReads = 0;
      await call(query);
      return onPage(0, 'eq')
        .filter((c) => c.args[0] === 'is_spam')
        .map((c) => c.args[1]);
    };
    expect(await spamFilter('')).toEqual([false]);
    expect(await spamFilter('?spam=true')).toEqual([true]);
    // A legacy link filtered on the spam status asks for spam too.
    expect(await spamFilter('?status=spam')).toEqual([true]);
  });

  it('refuses a search term in the link (it would sit in history and logs)', async () => {
    expect((await call('?q=sara%40acme.sa')).status).toBe(422);
    expect(leadCalls()).toEqual([]);
  });
});

describe('the lead export (C3): columns', () => {
  it('never reads note bodies or the address, and exports a note count instead', async () => {
    const res = await call();
    const select = leadCalls().find((c) => c.method === 'select')!;
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
      args: { p_tenant: TENANT, p_leads: [LEAD] },
    });
  });
});

describe('the lead export (C3): keyset paging', () => {
  it('a short page is not the end: it reads on from the last key until a page comes back empty', async () => {
    // A server whose row limit is 40: every page is cut at 40 whatever was asked.
    pages = [leads(40), leads(40, 40), leads(21, 80)];
    const res = await call();
    expect(res.status).toBe(200);
    expect(leadReads).toBe(4);
    expect(onPage(0, 'or')).toEqual([]);
    const last = leads(40)[39]!;
    expect(onPage(1, 'or')[0]!.args).toEqual([
      `created_at.lt."${String(last['created_at'])}",and(created_at.eq."${String(last['created_at'])}",id.gt.${String(last['id'])})`,
    ]);
    // Each page asks for what is still wanted, one past the cap at most.
    expect([0, 1, 2, 3].map((p) => onPage(p, 'limit')[0]!.args[0])).toEqual(
      [0, 40, 80, 101].map((n) => Math.min(PAGE_ROWS, MAX_EXPORT_ROWS + 1 - n)),
    );
    // No offsets: a lead arriving mid-export cannot shift a page.
    expect(leadCalls().filter((c) => c.method === 'range')).toEqual([]);
    const lines = (await res.text()).trim().split(/\r?\n/);
    expect(lines).toHaveLength(1 + 101);
    expect(outcome()).toMatchObject({ status: 'ok', rows: 101, truncated: false });
  });

  it('one row past the cap: the export carries the cap and says it is truncated', async () => {
    pages = [leads(MAX_EXPORT_ROWS + 1)];
    const res = await call();
    expect(res.status).toBe(200);
    expect(leadReads).toBe(1);
    expect((await res.text()).trim().split(/\r?\n/)).toHaveLength(1 + MAX_EXPORT_ROWS);
    expect(outcome()).toMatchObject({ status: 'ok', rows: MAX_EXPORT_ROWS, truncated: true });
  });

  it('exactly the cap is not truncated', async () => {
    pages = [leads(MAX_EXPORT_ROWS)];
    await call();
    expect(outcome()).toMatchObject({ rows: MAX_EXPORT_ROWS, truncated: false });
  });

  it('stops at the page bound, and then cannot say it has everything', async () => {
    pages = Array.from({ length: MAX_PAGES + 5 }, (_, p) => leads(1, p));
    await call();
    expect(leadReads).toBe(MAX_PAGES);
    expect(outcome()).toMatchObject({ rows: MAX_PAGES, truncated: true });
  });

  it('a row without a usable key fails the export, with a failed outcome', async () => {
    pages = [[{ ...ROW, id: 'not-a-uuid' }]];
    expect((await call()).status).toBe(500);
    expect(outcome()).toMatchObject({ status: 'failed' });
  });
});
