import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { APIContext } from 'astro';
import { ContactMergeSchema, DuplicateDismissSchema, DuplicatePairSchema } from '@schemas/crmMerge';
import {
  FILES_NEED_ADMIN_TEXT,
  isFilesRefusal,
  movesLine,
  olderFirst,
  reasonLine,
} from '@/lib/crm/mergeView';
import { parseDuplicatePairs, parseMergeOutcome } from '@/lib/crm/merge';
import { ROLE_CAPS } from '@/lib/authz/matrix';
import { MANUAL_LEAD_LIMITS, PII_REVEAL_LIMITS } from '@/lib/admin/rateLimit';

// Merging duplicate contacts (Admin v2 C12, crm.md §5.5 and §9): the merge runs its order (a
// live recheck, its own limit, both people read as the caller, then the service role's door,
// which writes the audit row itself) and stops at the first refusal; the finder's answer
// never carries a contact detail, whatever the database answers; "Not a duplicate" runs as the
// caller and is audited; the schemas are strict; the words say why, never what matched; and
// 0138 restates C5's purge with its marked lines only.

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';
const KEEP = '22222222-2222-4222-8222-222222222222';
const DROP = '33333333-3333-4333-8333-333333333333';

let limited = false;
// The ledger keys refused as spent (a 429 for that key alone).
let limitedOps: Set<string> = new Set();
const claims: { op: string; limits: unknown }[] = [];
let rlsSees: Set<string> = new Set([KEEP, DROP]);
let liveProfile: Record<string, unknown> = { role: 'admin', is_active: true, locked_until: null };
const events: string[] = [];
const audits: { action: string; entityId?: string; detail?: Record<string, unknown> }[] = [];
const rpcCalls: { owner: string; fn: string; args: Record<string, unknown> }[] = [];
let rpcAnswers: Record<string, { data: unknown; error: unknown }> = {};
// The two records' files as the service role counts them (the owner's decision of 2026-11-13).
let filesCount: number | null = 0;
let filesError: { code: string } | null = null;
const fileFilters: string[] = [];

vi.mock('@/lib/admin/audit', () => ({
  writeAudit: async (
    _sb: unknown,
    _auth: unknown,
    entry: { action: string; entityId?: string; detail?: Record<string, unknown> },
  ) => {
    events.push(`audit:${entry.action}`);
    audits.push(entry);
    return true;
  },
  writeAuditMany: async () => true,
}));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));
vi.mock('@/lib/admin/rateLimit', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/admin/rateLimit')>('@/lib/admin/rateLimit');
  const { RateLimitError } = await import('@/lib/admin/errors');
  return {
    ...actual,
    claimPrivilegedOp: async (_a: unknown, op: string, limits: unknown) => {
      events.push(`ops:${op}`);
      claims.push({ op, limits });
      if (limited || limitedOps.has(op)) throw new RateLimitError(`${op}:user`);
    },
  };
});

function builder(table: string, owner: 'svc' | 'rls') {
  const filters: Record<string, unknown> = {};
  const b: Record<string, unknown> = {};
  b['select'] = () => b;
  b['eq'] = (column: string, value: unknown) => {
    filters[column] = value;
    return b;
  };
  b['in'] = (column: string, values: unknown[]) => {
    filters[column] = values;
    return b;
  };
  // A head count (`select('id', { count: 'exact', head: true })`), awaited directly.
  b['then'] = (ok: (v: unknown) => unknown) => {
    events.push(`${owner}:count:${table}`);
    fileFilters.push(JSON.stringify(filters));
    return Promise.resolve({ count: filesCount, error: filesError }).then(ok);
  };
  b['maybeSingle'] = async () => {
    events.push(`${owner}:${table}`);
    if (table === 'profiles') return { data: liveProfile, error: null };
    const id = String(filters['id']);
    if (table === 'crm_contacts' && !rlsSees.has(id)) return { data: null, error: null };
    return { data: { id, merged_into: null }, error: null };
  };
  return b;
}

function client(owner: 'svc' | 'rls') {
  return {
    from: (table: string) => builder(table, owner),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      events.push(`${owner}:rpc:${fn}`);
      rpcCalls.push({ owner, fn, args });
      return rpcAnswers[fn] ?? { data: null, error: null };
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({ serviceClient: () => client('svc') }));

function ctx(path: string, method = 'GET', body?: unknown, role = 'admin'): APIContext {
  const url = new URL(`https://admin.example.test${path}`);
  return {
    request: new Request(url, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    }),
    url,
    params: {},
    locals: {
      session: { userId: USER, tenantId: TENANT, role, email: 'a@x', isActive: true },
      supabase: client('rls'),
    },
  } as unknown as APIContext;
}

async function data(res: Response): Promise<unknown> {
  return ((await res.json()) as { data: unknown }).data;
}

const MERGE_BODY = { keepId: KEEP, keepVersion: 3, dropId: DROP, dropVersion: 1 };

/** A finder row as the database might answer it, poisoned with what must never leave. */
function poisonedPair(): Record<string, unknown> {
  const person = (id: string, name: string) => ({
    id,
    display_name: name,
    title: null,
    company_name: 'Acme',
    stage: 'lead',
    created_at: '2026-01-01T00:00:00Z',
    last_activity_at: '2026-11-01T00:00:00Z',
    version: 2,
    leads: 1,
    emails: 1,
    phones: 1,
    email: 'sara@acme.sa',
    value_hmac: 'a'.repeat(64),
    value_enc: 'enc:+966500000000',
  });
  return {
    reasons: ['phone', 'secret_rule'],
    a: person(KEEP, 'Sara Ali'),
    b: person(DROP, 'sara ali'),
    phone_hmac: 'b'.repeat(64),
  };
}

beforeEach(() => {
  limited = false;
  limitedOps = new Set();
  claims.length = 0;
  rlsSees = new Set([KEEP, DROP]);
  liveProfile = { role: 'admin', is_active: true, locked_until: null };
  events.length = 0;
  audits.length = 0;
  rpcCalls.length = 0;
  rpcAnswers = {};
  filesCount = 0;
  filesError = null;
  fileFilters.length = 0;
});

describe('POST /api/admin/crm/contacts/merge', () => {
  const load = () => import('@/pages/api/admin/crm/contacts/merge');

  it('rechecks live, claims its limit, reads both as the caller, then calls the door as the service role', async () => {
    rpcAnswers['crm_merge_contacts'] = {
      data: {
        keep: KEEP,
        version: 4,
        leads: 2,
        channels: 1,
        notes: 3,
        tasks: 0,
        events: 5,
        duplicates: 1,
        value_hmac: 'a'.repeat(64),
      },
      error: null,
    };
    const { POST } = await load();
    const res = await POST(ctx('/api/admin/crm/contacts/merge', 'POST', MERGE_BODY));
    expect(res.status).toBe(200);
    expect(events).toEqual([
      'svc:profiles',
      'ops:crm-merge',
      'rls:crm_contacts',
      'rls:crm_contacts',
      'svc:rpc:crm_merge_contacts',
    ]);
    expect(rpcCalls[0]?.args).toEqual({
      p_tenant: TENANT,
      p_keep: KEEP,
      p_keep_version: 3,
      p_drop: DROP,
      p_drop_version: 1,
      p_actor: USER,
    });
    expect(await data(res)).toEqual({
      keepId: KEEP,
      version: 4,
      moved: { leads: 2, channels: 1, notes: 3, tasks: 0 },
    });
    // The database writes the audit row in the merge's transaction; the Worker queues none.
    expect(audits).toEqual([]);
  });

  it('an Admin merge spends no reveal slot (Admin may take every lead’s details at once)', async () => {
    const { POST } = await load();
    const res = await POST(ctx('/api/admin/crm/contacts/merge', 'POST', MERGE_BODY));
    expect(res.status).toBe(200);
    expect(claims.map((c) => c.op)).toEqual(['crm-merge']);
  });

  // (C12 review, C12-SEC-R2-1) Once C10b gives Sales crm.contacts, a Sales merge moves the
  // other person's e-mails and phones onto the record its next reveal decrypts, so it spends a
  // slot of the reveal's own limiter first, fail-closed, as C10b's link confirm does. Sales
  // holds crm.contacts here only for these cases (C10b flips the matrix itself).
  describe('as Sales (C10b gives it crm.contacts)', () => {
    const before = ROLE_CAPS.sales['crm.contacts'];
    beforeEach(() => {
      ROLE_CAPS.sales['crm.contacts'] = 'full';
      liveProfile = { role: 'sales', is_active: true, locked_until: null };
      return () => {
        ROLE_CAPS.sales['crm.contacts'] = before;
      };
    });

    // (C-int review, CINT2-SEC-2) The merge limit and the caller's own reads of both people
    // (ids only) come first, then the file count, then the reveal slot, then the door.
    it('spends a pii-reveal slot after the limit, the reads and the file count, before the door', async () => {
      const { POST } = await load();
      const res = await POST(ctx('/api/admin/crm/contacts/merge', 'POST', MERGE_BODY, 'sales'));
      expect(res.status).toBe(200);
      expect(events).toEqual([
        'svc:profiles',
        'ops:crm-merge',
        'rls:crm_contacts',
        'rls:crm_contacts',
        'svc:count:crm_contact_files',
        'ops:pii-reveal',
        'svc:rpc:crm_merge_contacts',
      ]);
      expect(claims).toEqual([
        { op: 'crm-merge', limits: MANUAL_LEAD_LIMITS },
        { op: 'pii-reveal', limits: PII_REVEAL_LIMITS },
      ]);
    });

    it('with no reveal slot left: a 429, no merge', async () => {
      limitedOps = new Set(['pii-reveal']);
      const { POST } = await load();
      const res = await POST(ctx('/api/admin/crm/contacts/merge', 'POST', MERGE_BODY, 'sales'));
      expect(res.status).toBe(429);
      expect(events.at(-1)).toBe('ops:pii-reveal');
      expect(rpcCalls).toEqual([]);
    });

    // CINT2-SEC-2: the file count is no free oracle. Past the merge limit, or naming a person the
    // caller cannot see (another tenant's, a merged record, a made-up id), it never runs.
    it('past the merge limit, a Sales request never counts files', async () => {
      filesCount = 1;
      limitedOps = new Set(['crm-merge']);
      const { POST } = await load();
      const res = await POST(ctx('/api/admin/crm/contacts/merge', 'POST', MERGE_BODY, 'sales'));
      expect(res.status).toBe(429);
      expect(events).toEqual(['svc:profiles', 'ops:crm-merge']);
    });

    it('naming a person the caller cannot see is a 404 before the files are counted', async () => {
      filesCount = 1;
      rlsSees = new Set([KEEP]);
      const { POST } = await load();
      const res = await POST(ctx('/api/admin/crm/contacts/merge', 'POST', MERGE_BODY, 'sales'));
      expect(res.status).toBe(404);
      expect(events).not.toContain('svc:count:crm_contact_files');
      expect(claims.map((c) => c.op)).toEqual(['crm-merge']);
      expect(rpcCalls).toEqual([]);
    });

    // The owner's decision of 2026-11-13: a merge where either record holds a file needs an
    // Admin. Refused before any reveal slot or the door, so no reveal is spent and nothing
    // moves; the merge limit is spent (CINT2-SEC-2: every such question costs one).
    it('a pair where either record holds a file: a 403 naming crm.files, before the reveal slot', async () => {
      filesCount = 1;
      const { POST } = await load();
      const res = await POST(ctx('/api/admin/crm/contacts/merge', 'POST', MERGE_BODY, 'sales'));
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['capability']).toBe('crm.files');
      expect(isFilesRefusal(res.status, body)).toBe(true);
      expect(events).toEqual([
        'svc:profiles',
        'ops:crm-merge',
        'rls:crm_contacts',
        'rls:crm_contacts',
        'svc:count:crm_contact_files',
      ]);
      expect(claims.map((c) => c.op)).toEqual(['crm-merge']);
      expect(rpcCalls).toEqual([]);
      // Counted for this tenant and these two people only.
      expect(JSON.parse(fileFilters[0]!)).toEqual({ tenant_id: TENANT, contact_id: [KEEP, DROP] });
    });

    it('a count that fails refuses too (fail-closed), before the reveal slot', async () => {
      filesError = { code: '57014' };
      const { POST } = await load();
      const res = await POST(ctx('/api/admin/crm/contacts/merge', 'POST', MERGE_BODY, 'sales'));
      expect(res.status).toBe(500);
      expect(claims.map((c) => c.op)).toEqual(['crm-merge']);
      expect(rpcCalls).toEqual([]);
    });

    it('the door refusing a file added since the count is the same 403', async () => {
      rpcAnswers['crm_merge_contacts'] = {
        data: null,
        error: {
          code: '42501',
          message: 'crm_merge_contacts: one of these records holds files, so an Admin merges them',
        },
      };
      const { POST } = await load();
      const res = await POST(ctx('/api/admin/crm/contacts/merge', 'POST', MERGE_BODY, 'sales'));
      expect(res.status).toBe(403);
      expect(((await res.json()) as Record<string, unknown>)['capability']).toBe('crm.files');
    });
  });

  it('an Admin never counts files, and merges a pair holding files', async () => {
    filesCount = 3;
    const { POST } = await load();
    const res = await POST(ctx('/api/admin/crm/contacts/merge', 'POST', MERGE_BODY));
    expect(res.status).toBe(200);
    expect(events).not.toContain('svc:count:crm_contact_files');
    expect(rpcCalls.map((c) => c.fn)).toEqual(['crm_merge_contacts']);
  });

  it('a demoted, switched-off or locked profile is refused before anything else', async () => {
    const { POST } = await load();
    for (const profile of [
      { role: 'content_creator', is_active: true, locked_until: null },
      { role: 'admin', is_active: false, locked_until: null },
      { role: 'admin', is_active: true, locked_until: '2999-01-01T00:00:00Z' },
    ]) {
      events.length = 0;
      liveProfile = profile;
      const res = await POST(ctx('/api/admin/crm/contacts/merge', 'POST', MERGE_BODY));
      expect(res.status).toBe(403);
      expect(events).toEqual(['svc:profiles']);
    }
  });

  it('past its limit: a 429 before either person is read or the door called', async () => {
    limited = true;
    const { POST } = await load();
    const res = await POST(ctx('/api/admin/crm/contacts/merge', 'POST', MERGE_BODY));
    expect(res.status).toBe(429);
    expect(events).toEqual(['svc:profiles', 'ops:crm-merge']);
  });

  it('a person the caller cannot see (another tenant, a merged record) is a 404 and the door is never called', async () => {
    rlsSees = new Set([KEEP]);
    const { POST } = await load();
    const res = await POST(ctx('/api/admin/crm/contacts/merge', 'POST', MERGE_BODY));
    expect(res.status).toBe(404);
    expect(rpcCalls).toEqual([]);
  });

  it.each([
    ['40001', 409],
    ['40P01', 409],
    ['P0002', 404],
    ['42501', 403],
    ['22023', 422],
  ])('the door refusing with %s answers %i', async (code, status) => {
    rpcAnswers['crm_merge_contacts'] = { data: null, error: { code, message: 'no' } };
    const { POST } = await load();
    const res = await POST(ctx('/api/admin/crm/contacts/merge', 'POST', MERGE_BODY));
    expect(res.status).toBe(status);
  });

  it('the channel ceiling is a 422 in plain words, on the channels', async () => {
    rpcAnswers['crm_merge_contacts'] = {
      data: null,
      error: {
        code: '23514',
        message:
          'a contact keeps at most ten e-mails and ten phones (constraint "crm_contact_channels_cap")',
      },
    };
    const { POST } = await load();
    const res = await POST(ctx('/api/admin/crm/contacts/merge', 'POST', MERGE_BODY));
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain('up to 10 e-mail addresses');
  });

  it('a body naming one person twice, or with anything else in it, is refused before any read', async () => {
    const { POST } = await load();
    for (const body of [
      { ...MERGE_BODY, dropId: KEEP },
      { ...MERGE_BODY, note: 'x' },
      { ...MERGE_BODY, keepVersion: 0 },
      { keepId: KEEP, dropId: DROP },
    ]) {
      events.length = 0;
      const res = await POST(ctx('/api/admin/crm/contacts/merge', 'POST', body));
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(events).toEqual([]);
    }
  });

  it('has no GET', async () => {
    const mod = (await load()) as Record<string, unknown>;
    expect(mod['GET']).toBeUndefined();
  });
});

describe('GET /api/admin/crm/duplicates', () => {
  it('reads as the caller, at most 50, and passes on no contact detail', async () => {
    rpcAnswers['crm_duplicate_pairs'] = { data: [poisonedPair(), { a: null }], error: null };
    const { GET } = await import('@/pages/api/admin/crm/duplicates/index');
    const res = await GET(ctx('/api/admin/crm/duplicates'));
    expect(res.status).toBe(200);
    expect(rpcCalls).toEqual([
      { owner: 'rls', fn: 'crm_duplicate_pairs', args: { p_tenant: TENANT, p_limit: 50 } },
    ]);
    const answer = (await data(res)) as { pairs: unknown[] };
    expect(answer.pairs).toHaveLength(1);
    const text = JSON.stringify(answer);
    for (const secret of ['sara@acme.sa', '+966500000000', 'a'.repeat(64), 'b'.repeat(64)]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain('secret_rule');
    expect(DuplicatePairSchema.safeParse(answer.pairs[0]).success).toBe(true);
    expect(audits).toEqual([]);
  });
});

describe('POST /api/admin/crm/duplicates/dismiss', () => {
  it('runs as the caller and is audited with the two ids', async () => {
    rpcAnswers['crm_dismiss_duplicate'] = { data: true, error: null };
    const { POST } = await import('@/pages/api/admin/crm/duplicates/dismiss');
    const res = await POST(ctx('/api/admin/crm/duplicates/dismiss', 'POST', { a: KEEP, b: DROP }));
    expect(res.status).toBe(200);
    expect(rpcCalls).toEqual([
      {
        owner: 'rls',
        fn: 'crm_dismiss_duplicate',
        args: { p_tenant: TENANT, p_a: KEEP, p_b: DROP },
      },
    ]);
    expect(audits.map((a) => [a.action, a.detail])).toEqual([
      ['crm.contact.duplicate_dismiss', { a: KEEP, b: DROP, new: true }],
    ]);
  });

  it('an unseen pair is a 404 and nothing is audited', async () => {
    rpcAnswers['crm_dismiss_duplicate'] = { data: null, error: { code: 'P0002', message: 'no' } };
    const { POST } = await import('@/pages/api/admin/crm/duplicates/dismiss');
    const res = await POST(ctx('/api/admin/crm/duplicates/dismiss', 'POST', { a: KEEP, b: DROP }));
    expect(res.status).toBe(404);
    expect(audits).toEqual([]);
  });
});

describe('the schemas are strict', () => {
  it('merge: two different people, each with a version, nothing else', () => {
    expect(ContactMergeSchema.safeParse(MERGE_BODY).success).toBe(true);
    expect(ContactMergeSchema.safeParse({ ...MERGE_BODY, dropId: KEEP }).success).toBe(false);
    expect(ContactMergeSchema.safeParse({ ...MERGE_BODY, extra: 1 }).success).toBe(false);
    expect(ContactMergeSchema.safeParse({ ...MERGE_BODY, keepVersion: 1.5 }).success).toBe(false);
  });
  it('dismiss: two different ids, nothing else', () => {
    expect(DuplicateDismissSchema.safeParse({ a: KEEP, b: DROP }).success).toBe(true);
    expect(DuplicateDismissSchema.safeParse({ a: KEEP, b: KEEP }).success).toBe(false);
    expect(DuplicateDismissSchema.safeParse({ a: KEEP, b: DROP, why: 'x' }).success).toBe(false);
  });
});

describe('the words', () => {
  it('a merge refused for files tells the person to ask an Admin (P-12: no dashes)', () => {
    expect(FILES_NEED_ADMIN_TEXT).toBe(
      'One of these two records holds files, so an Admin needs to merge them. Ask an Admin.',
    );
    expect(FILES_NEED_ADMIN_TEXT).not.toMatch(/[–—]/);
    expect(isFilesRefusal(403, { capability: 'crm.files' })).toBe(true);
    expect(isFilesRefusal(403, { capability: 'crm.contacts' })).toBe(false);
    expect(isFilesRefusal(409, { capability: 'crm.files' })).toBe(false);
    const dialog = readFileSync(
      'src/components/admin/screens/contacts/MergeDuplicatesDialog.tsx',
      'utf8',
    );
    expect(dialog).toContain('isFilesRefusal(err.info.status, err.body)');
    expect(dialog).toContain('setPairError({ key, text: FILES_NEED_ADMIN_TEXT })');
  });

  const [pair] = parseDuplicatePairs([poisonedPair()]);

  it('say why, never what matched (P-12: no dashes)', () => {
    expect(reasonLine(['phone', 'name_company'])).toBe(
      'Same phone number. Same name at the same company.',
    );
    expect(reasonLine(['phone'])).not.toMatch(/[–—]/);
  });

  it('keep the older record by default', () => {
    expect(pair).toBeDefined();
    const later = { ...pair!, b: { ...pair!.b, created_at: '2025-01-01T00:00:00Z' } };
    expect(olderFirst(pair!).keep.id).toBe(KEEP);
    expect(olderFirst(later).keep.id).toBe(DROP);
  });

  it('count what moves', () => {
    expect(movesLine(pair!.b)).toBe(
      'Their 1 lead, 1 e-mail address, 1 phone number, notes, tasks and timeline move.',
    );
    expect(movesLine({ ...pair!.b, leads: 2, emails: 0, phones: 3 })).toBe(
      'Their 2 leads, 3 phone numbers, notes, tasks and timeline move.',
    );
  });

  it('read a missing count as none', () => {
    expect(parseMergeOutcome({ version: 2 }, KEEP).moved).toEqual({
      leads: 0,
      channels: 0,
      notes: 0,
      tasks: 0,
    });
  });
});

// ---- The database half's shape (0138) ----------------------------------------------------------

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');
const read = (file: string) => readFileSync(join(MIGRATIONS, file), 'utf8').replace(/\r\n/g, '\n');
const C5 = read('0131_crm_contacts.sql');
const C8 = read('0134_crm_tasks.sql');
const C12 = read(readdirSync(MIGRATIONS).find((f) => /_crm_merge\.sql$/.test(f)) ?? '');

function fn(sql: string, name: string, end: string): string {
  const start = sql.indexOf(`create or replace function ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const stop = sql.indexOf(end, start);
  expect(stop, name).toBeGreaterThan(start);
  return sql.slice(start, stop + end.length);
}

describe('0138', () => {
  it('restates app.purge_crm as C5 wrote it plus the lines marked -- C12', () => {
    const before = fn(C5, 'app.purge_crm', 'end $$;');
    const after = fn(C12, 'app.purge_crm', 'end $$;');
    const marked = after.split('\n').filter((line) => / {2}-- C12$/.test(line));
    expect(marked.length).toBeGreaterThan(0);
    expect(marked.join('\n')).toMatch(/merged_into is not null/);
    expect(
      after
        .split('\n')
        .filter((line) => !/ {2}-- C12$/.test(line))
        .join('\n'),
    ).toBe(before);
  });

  // (C12 review, C12-COR-3) An erasure that waited on a merge's lock would otherwise erase the
  // tombstone and say it was done, while the person sits on the survivor.
  it('restates public.crm_erase_person as C8 wrote it plus the lines marked -- C12 (a tombstone is P0002)', () => {
    const before = fn(C8, 'public.crm_erase_person', 'end $$;');
    const after = fn(C12, 'public.crm_erase_person', 'end $$;');
    const marked = after.split('\n').filter((line) => / {2}-- C12$/.test(line));
    expect(marked.join('\n')).toMatch(/merged_into is not null[\s\S]*'P0002'/);
    expect(
      after
        .split('\n')
        .filter((line) => !/ {2}-- C12$/.test(line))
        .join('\n'),
    ).toBe(before);
    // The check comes after the row is locked, so it reads what a merge that held it wrote.
    expect(after.indexOf('merged_into is not null')).toBeGreaterThan(after.indexOf('for update'));
    expect(C12).toMatch(
      /grant execute on function public\.crm_erase_person\(uuid, uuid, uuid\[\], uuid\) to service_role;/,
    );
  });

  it('the merge is the service role’s INVOKER door, checking the actor live before it locks or moves anything', () => {
    const merge = fn(C12, 'public.crm_merge_contacts', 'end $$;');
    expect(merge).toMatch(/security invoker/);
    expect(merge).not.toMatch(/security definer/);
    const actor = merge.indexOf('app.crm_contacts_actor_ok(p_tenant, p_actor, false)');
    expect(actor).toBeGreaterThan(0);
    expect(actor).toBeLessThan(merge.indexOf('pg_advisory_xact_lock'));
    expect(actor).toBeLessThan(merge.indexOf('for update'));
    // The audit row is written inside the merge, so no row means no merge.
    expect(merge).toMatch(/insert into public\.audit_log[\s\S]*'crm\.contact\.merge'/);
    expect(C12).toMatch(
      /grant execute on function public\.crm_merge_contacts\(uuid, uuid, int, uuid, int, uuid\) to service_role;/,
    );
  });

  it('the readers are SECURITY INVOKER; only the blind-index comparison is a definer', () => {
    for (const name of ['public.crm_duplicate_pairs', 'public.crm_dismiss_duplicate']) {
      const head = fn(C12, name, 'as $$');
      expect(head, name).toMatch(/security invoker/);
      expect(head, name).not.toMatch(/security definer/);
    }
    const finder = fn(C12, 'app.crm_duplicate_candidates', 'end $$;');
    expect(finder).toMatch(/security definer set search_path = ''/);
    expect(finder).toMatch(/app\.role_crm_contacts\(app\.live_role\(\)\)/);
    expect(finder).toMatch(/v_tenant uuid := app\.effective_tenant_id\(\)/);
  });
});

// ---- Callers ----------------------------------------------------------------------------------

const SRC = join(process.cwd(), 'src');
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|astro)$/.test(name) ? [path] : [];
  });
}
const files = sourceFiles(SRC).map((path) => ({
  path: relative(process.cwd(), path).replace(/\\/g, '/'),
  code: readFileSync(path, 'utf8'),
}));
const callers = (name: string) =>
  files
    .filter((f) => new RegExp(`rpc\\(\\s*['"]${name}['"]`).test(f.code))
    .map((f) => f.path)
    .sort();

describe('the merge functions have named callers', () => {
  it.each([
    ['crm_merge_contacts', 'src/pages/api/admin/crm/contacts/merge.ts'],
    ['crm_duplicate_pairs', 'src/pages/api/admin/crm/duplicates/index.ts'],
    ['crm_dismiss_duplicate', 'src/pages/api/admin/crm/duplicates/dismiss.ts'],
  ])('%s: %s only', (name, file) => {
    expect(callers(name)).toEqual([file]);
  });
});
