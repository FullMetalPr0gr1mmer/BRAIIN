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
const systemLogs: { level: string; message: string; detail?: Record<string, unknown> }[] = [];
let pages: Record<string, unknown>[][] = [];
let leadReads = 0;
let disciplineExists = true;
const DISCIPLINE = '88888888-8888-4888-8888-888888888888';

function recorder(owner: string, table: string) {
  const b: Record<string, unknown> = {};
  const page = table === 'leads' ? leadReads++ : -1;
  for (const m of [
    'select',
    'eq',
    'gte',
    'lte',
    'lt',
    'or',
    'in',
    'is',
    'not',
    'order',
    'limit',
    'range',
  ]) {
    b[m] = (...args: unknown[]) => {
      calls.push({ owner, table, method: m, args, page });
      return b;
    };
  }
  b['then'] = (ok: (v: unknown) => unknown) => {
    let data: unknown = [];
    if (table === 'leads') data = pages.shift() ?? [];
    if (table === 'lead_stages') data = [{ id: STAGE, label: 'Proposal sent' }];
    // A discipline's services (C4a): one with a slug PostgREST could misread is dropped.
    if (table === 'services')
      data = [{ slug: 'logo' }, { slug: 'motion-graphics' }, { slug: 'a,b' }];
    return Promise.resolve({ data, error: null }).then(ok);
  };
  b['maybeSingle'] = async () => {
    calls.push({ owner, table, method: 'maybeSingle', args: [], page });
    return {
      data: table === 'disciplines' && disciplineExists ? { id: DISCIPLINE } : null,
      error: null,
    };
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
const claims: string[] = [];
vi.mock('@/lib/admin/rateLimit', () => ({
  claimPrivilegedOp: async (_auth: unknown, op: string) => {
    claims.push(op);
  },
}));
vi.mock('@/lib/admin/audit', () => ({
  writeAudit: async (_sb: unknown, _auth: unknown, entry: (typeof audits)[number]) => {
    audits.push(entry);
    return true;
  },
}));
vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async (entry: (typeof systemLogs)[number]) => {
    systemLogs.push(entry);
    return true;
  },
}));
// The key the export imports, and every key a decrypt is handed: the export must import it
// once a request and hand that key to every decrypt (importing costs what a decrypt does).
const IMPORTED_KEY = { imported: true };
const keyImports: string[] = [];
const decryptKeys: unknown[] = [];
let keyImportFails = false;
vi.mock('@/lib/crypto/pii', () => ({
  importPIIKey: async (material: string) => {
    keyImports.push(material);
    if (keyImportFails) throw new Error('importKey failed');
    return IMPORTED_KEY;
  },
  decryptPII: async (v: string, key: unknown) => {
    decryptKeys.push(key);
    return v.replace(/^enc:/, '');
  },
}));
vi.mock('@/lib/leads/interestLabel', () => ({
  resolveLeadInterests: async () => new Map(),
  withInterestLabels: (r: Record<string, unknown>) => r,
}));

const { GET } = await import('@/pages/api/admin/leads/export');
const { EXPORT_ROW_CAP, MAX_PAGES, PAGE_ROWS } = await import('@/lib/crm/exportRead');
// Every role holding export.csv holds leads.pii, so every export here is a PII export.
const CAP = EXPORT_ROW_CAP.pii;

function call(query = '', headers: Record<string, string> = {}) {
  const url = new URL(`https://admin.example.test/api/admin/leads/export${query}`);
  return (GET as APIRoute)({
    request: new Request(url, { headers }),
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
  // Today's schema still holds the legacy columns: the stand-in answers them whatever is asked.
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
  claims.length = 0;
  calls.length = 0;
  rpcs.length = 0;
  audits.length = 0;
  systemLogs.length = 0;
  keyImports.length = 0;
  decryptKeys.length = 0;
  keyImportFails = false;
  leadReads = 0;
  disciplineExists = true;
  pages = [[ROW]];
});

/** One CSV line's cells: quoted ones may hold commas, empty ones are bare (toCsv). */
function cells(line: string): string[] {
  return [...line.replace(/^﻿/, '').matchAll(/(?:^|,)(?:"((?:[^"]|"")*)"|([^,]*))/g)].map((m) =>
    (m[1] ?? m[2] ?? '').replace(/""/g, '"'),
  );
}

describe('the lead export: never on another site’s say-so (U13 review)', () => {
  it('a cross-site link is refused before a slot, a row or a lead is touched', async () => {
    for (const headers of [
      { 'sec-fetch-site': 'cross-site' },
      { origin: 'https://evil.example' },
      { referer: 'https://evil.example/trap' },
    ]) {
      claims.length = 0;
      audits.length = 0;
      calls.length = 0;
      const res = await call('', headers);
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(claims).toEqual([]);
      expect(audits).toEqual([]);
      expect(calls.filter((c) => c.table === 'leads')).toEqual([]);
    }
    const ours = await call('', { 'sec-fetch-site': 'same-origin' });
    expect(ours.status).toBe(200);
    expect(claims).toEqual(['export-csv']);
  });
});

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
  });

  // Admin v2 C14a: the legacy status is the contract's to drop (C14b), so the export no longer
  // filters on it. A link that still carries it is refused, naming the field and saying what to
  // do, before a slot, an audit row or a lead is touched; never an export of more than it asked.
  it('refuses a legacy ?status= link with a 422 naming it, before anything is spent', async () => {
    for (const query of ['?status=spam', '?status=new', `?stage=${STAGE}&status=done`]) {
      claims.length = 0;
      audits.length = 0;
      calls.length = 0;
      const res = await call(query);
      expect(res.status, query).toBe(422);
      expect(JSON.stringify(await res.json()), query).toContain('Choose a stage instead');
      expect(claims, query).toEqual([]);
      expect(audits, query).toEqual([]);
      expect(leadCalls(), query).toEqual([]);
    }
  });

  // C4a: the list's other filters a link may carry.
  it('assigned: the session\'s user for "me", none, or a person', async () => {
    const assigned = async (query: string) => {
      calls.length = 0;
      leadReads = 0;
      expect((await call(query)).status, query).toBe(200);
      return onPage(0, 'eq')
        .concat(onPage(0, 'is'))
        .filter((c) => c.args[0] === 'assigned_to')
        .map((c) => `${c.method}:${String(c.args[1])}`);
    };
    // "me" is the session's user, never a value in the link.
    expect(await assigned('?assigned=me')).toEqual([`eq:${USER}`]);
    expect(await assigned('?assigned=none')).toEqual(['is:null']);
    expect(await assigned(`?assigned=${PERSON}`)).toEqual([`eq:${PERSON}`]);
    expect(await assigned('')).toEqual([]);
    expect((await call('?assigned=someone')).status).toBe(422);
  });

  it('source, channel, star and read mark become PostgREST filters on the read', async () => {
    await call('?source=manual&channel=phone&starred=true&unread=true');
    const filters = onPage(0, 'eq').concat(onPage(0, 'is'));
    for (const expected of [
      ['eq', ['source', 'manual']],
      ['eq', ['channel', 'phone']],
      ['eq', ['is_starred', true]],
      ['is', ['read_at', null]],
    ] as const) {
      expect(filters).toContainEqual(
        expect.objectContaining({ owner: 'svc', method: expected[0], args: expected[1] }),
      );
    }
    calls.length = 0;
    leadReads = 0;
    await call('?starred=false&unread=false');
    expect(onPage(0, 'eq')).toContainEqual(
      expect.objectContaining({ args: ['is_starred', false] }),
    );
    expect(onPage(0, 'not')).toEqual([expect.objectContaining({ args: ['read_at', 'is', null] })]);
    for (const bad of ['?source=web', '?channel=fax', '?starred=yes', '?unread=1']) {
      expect((await call(bad)).status, bad).toBe(422);
    }
  });

  it('a discipline: its "help me choose" leads or its services\' leads, read once', async () => {
    await call('?discipline=branding');
    // The discipline and its services, read as the caller, once for the export.
    expect(calls.filter((c) => c.table === 'disciplines' && c.method === 'eq')).toEqual([
      expect.objectContaining({ owner: 'rls', args: ['tenant_id', TENANT] }),
      expect.objectContaining({ owner: 'rls', args: ['slug', 'branding'] }),
    ]);
    expect(calls.filter((c) => c.table === 'services' && c.method === 'eq')).toEqual([
      expect.objectContaining({ owner: 'rls', args: ['tenant_id', TENANT] }),
      expect.objectContaining({ owner: 'rls', args: ['discipline_id', DISCIPLINE] }),
    ]);
    expect(onPage(0, 'or').map((c) => c.args[0])).toEqual([
      'discipline_of_interest.eq.branding,service_of_interest.in.(logo,motion-graphics)',
    ]);
    // Page 2 (asked for because page 1 came back short of the cap) carries the discipline
    // AND the keyset: two `or` parameters, which PostgREST ANDs.
    expect(onPage(1, 'or').map((c) => c.args[0])).toEqual([
      'discipline_of_interest.eq.branding,service_of_interest.in.(logo,motion-graphics)',
      `created_at.lt."${ROW.created_at}",and(created_at.eq."${ROW.created_at}",id.gt.${LEAD})`,
    ]);
    // A discipline the tenant does not have: its own slug only.
    disciplineExists = false;
    calls.length = 0;
    leadReads = 0;
    await call('?discipline=events');
    expect(calls.filter((c) => c.table === 'services')).toEqual([]);
    expect(onPage(0, 'or').map((c) => c.args[0])).toEqual(['discipline_of_interest.eq.events']);
    for (const bad of [
      '?discipline=Bad%20Slug',
      '?discipline=a,b',
      `?discipline=${'a'.repeat(65)}`,
    ]) {
      expect((await call(bad)).status, bad).toBe(422);
    }
  });

  it('the attempt row names every filter the link carried', async () => {
    await call(
      `?assigned=me&source=manual&channel=phone&discipline=branding&starred=true&unread=false`,
    );
    const attempt = audits.find((a) => a.action === 'export.csv.attempt')!.detail!;
    expect(attempt).toMatchObject({
      assigned: 'me',
      source: 'manual',
      channel: 'phone',
      discipline: 'branding',
      starred: 'true',
      unread: 'false',
    });
  });

  it("never reads the score's reasons (they leave only through the one-lead reveal, D7)", async () => {
    await call();
    const select = leadCalls().find((c) => c.method === 'select')!;
    expect(String(select.args[0]).split(',')).not.toContain('score_signals');
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
    // No legacy column (C14a): the old status, the notes field, the address and the old band
    // are C14b's to drop, so the read works on the schema before and after that migration.
    for (const legacy of ['status', 'internal_notes', 'ip_inet', 'timeline_band']) {
      expect(columns, legacy).not.toContain(legacy);
    }
    expect(columns).toEqual(expect.arrayContaining(['stage_id', 'assigned_to', 'tags', 'score']));
    const text = await res.text();
    const [header, first] = text.trim().split(/\r?\n/);
    const head = cells(header!);
    const row = cells(first!);
    for (const legacy of ['status', 'internal_notes', 'ip_inet', 'timeline_band']) {
      expect(head, legacy).not.toContain(legacy);
    }
    // Even from a row that still carries them (today's schema; the stand-in answers them).
    expect(text).not.toContain('in_progress');
    expect(text).not.toContain('never exported');
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
    // A server whose row limit is a third of the cap: every page is cut there whatever was
    // asked. One lead fewer than the cap matches.
    const limit = Math.ceil(CAP / 3);
    const total = CAP - 1;
    pages = [leads(limit), leads(limit, limit), leads(total - 2 * limit, 2 * limit)];
    const res = await call();
    expect(res.status).toBe(200);
    expect(leadReads).toBe(4);
    expect(onPage(0, 'or')).toEqual([]);
    const last = leads(limit)[limit - 1]!;
    expect(onPage(1, 'or')[0]!.args).toEqual([
      `created_at.lt."${String(last['created_at'])}",and(created_at.eq."${String(last['created_at'])}",id.gt.${String(last['id'])})`,
    ]);
    // Each page asks for what is still wanted, one past the cap at most.
    expect([0, 1, 2, 3].map((p) => onPage(p, 'limit')[0]!.args[0])).toEqual(
      [0, limit, 2 * limit, total].map((n) => Math.min(PAGE_ROWS, CAP + 1 - n)),
    );
    // No offsets: a lead arriving mid-export cannot shift a page.
    expect(leadCalls().filter((c) => c.method === 'range')).toEqual([]);
    const lines = (await res.text()).trim().split(/\r?\n/);
    expect(lines).toHaveLength(1 + total);
    expect(outcome()).toMatchObject({ status: 'ok', rows: total, truncated: false });
    expect(res.headers.get('x-export-truncated')).toBe('false');
  });

  it('one row past the cap: the export carries the cap and says it is truncated', async () => {
    pages = [leads(CAP + 1)];
    const res = await call();
    expect(res.status).toBe(200);
    expect(leadReads).toBe(1);
    expect((await res.text()).trim().split(/\r?\n/)).toHaveLength(1 + CAP);
    expect(outcome()).toMatchObject({ status: 'ok', rows: CAP, truncated: true, cap: CAP });
    // Said where a screen can read it, and in the name a plain download link shows.
    expect(res.headers.get('x-export-truncated')).toBe('true');
    expect(res.headers.get('x-export-rows')).toBe(String(CAP));
    expect(res.headers.get('content-disposition')).toMatch(
      new RegExp(`filename="leads-\\d{4}-\\d{2}-\\d{2}-first-${CAP}\\.csv"`),
    );
    // Reaching the cap is the abnormal-volume signal (§3), a warning line with counts only.
    expect(systemLogs).toEqual([
      expect.objectContaining({
        level: 'warn',
        detail: { actorId: USER, role: 'admin', rows: CAP, cap: CAP, truncated: true },
      }),
    ]);
  });

  it('exactly the cap is not truncated', async () => {
    pages = [leads(CAP)];
    const res = await call();
    expect(outcome()).toMatchObject({ rows: CAP, truncated: false });
    expect(res.headers.get('x-export-truncated')).toBe('false');
    expect(res.headers.get('content-disposition')).toMatch(
      /filename="leads-\d{4}-\d{2}-\d{2}\.csv"/,
    );
  });

  it('an export under the cap writes no warning line', async () => {
    pages = [leads(3)];
    await call();
    expect(systemLogs).toEqual([]);
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

describe('the lead export (C3 review): CPU', () => {
  it('imports the key once for the request and hands it to every decrypt', async () => {
    pages = [
      leads(30).map((row) => ({
        ...row,
        phone_enc: 'enc:+966500000000',
        budget_enc: 'enc:gt_200k',
        timeline_text_enc: 'enc:Before Ramadan',
      })),
    ];
    const res = await call();
    expect(res.status).toBe(200);
    expect(keyImports).toEqual(['test-dummy-lead-pii-enc-key']);
    expect(decryptKeys).toHaveLength(30 * 4);
    expect(new Set(decryptKeys)).toEqual(new Set([IMPORTED_KEY]));
  });

  it('an export with no rows imports no key', async () => {
    pages = [];
    expect((await call()).status).toBe(200);
    expect(keyImports).toEqual([]);
  });

  it('a key that cannot be imported fails the export after the attempt, with a failed outcome', async () => {
    keyImportFails = true;
    expect((await call()).status).toBe(500);
    expect(audits.map((a) => a.action)).toEqual(['export.csv.attempt', 'export.csv.outcome']);
    expect(outcome()).toMatchObject({ status: 'failed', rows: 0 });
  });

  it('the caps stay within what the measurement fits (C3.md): raise them only with a new run', () => {
    // scripts/bench-lead-export.mjs measured at worst 74 µs a row with the contact details
    // decrypted and 19 without, against 10 ms of CPU a request on the Workers Free plan; a
    // cap's rows get 6 ms of it. The review's ceiling for the PII cap was 1,000.
    expect(EXPORT_ROW_CAP.pii).toBeLessThanOrEqual(1000);
    expect(EXPORT_ROW_CAP.pii * 74).toBeLessThanOrEqual(6000);
    expect(EXPORT_ROW_CAP.safe * 19).toBeLessThanOrEqual(6000);
    // The page bound is reached before the cap only when the server's row limit is tiny.
    expect(MAX_PAGES).toBeLessThan(EXPORT_ROW_CAP.pii);
  });
});
