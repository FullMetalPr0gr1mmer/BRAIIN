import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIContext } from 'astro';

// The contacts API (Admin v2 C6, crm.md §9, §13): the reveal runs the lead reveal's order
// (live recheck, the shared limiter, an RLS read, a WRITTEN audit row, then the ciphertext)
// and fails closed; the notes open only after their own written audit row; the list, the
// picker, the detail and the timeline never carry an e-mail, a phone, a channel's value or
// its index, whatever the database answers; a searched address reaches the database as its
// blind index only; custom values are held to their definitions; the bulk change writes one
// audit row per changed contact and one for the batch in one insert; the erasure is refused
// before the door when its attempt row is not written; a new lead carries no contact detail.
// The C6 review added: a note's delete (fail-closed attempt, its outcomes), the erasure preview
// (a POST, its own limit, the backfill for the caller's tenant only, then the door), the phone
// match's confirm and detach, the channel PATCH (sealed values only, the version, its
// refusals), a tombstone's details as unseen, the counts' named keys, and the notes' and
// leads' total order with a `more` flag.

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';
const CONTACT = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const NOTE = '44444444-4444-4444-8444-444444444444';

/** Fields that must never leave a list, picker, detail or timeline answer. */
const SECRET_KEYS = [
  'email',
  'phone',
  // (`value` is the list's won-lead value, a sum of money: not a contact detail.)
  'value_enc',
  'value_hmac',
  'email_enc',
  'phone_enc',
  'email_hmac',
  'phone_hmac',
  'budget_enc',
  'score_signals',
  'body',
];
const SECRET_VALUES = ['sara@acme.sa', '+966500000000', 'enc:', 'a'.repeat(64)];

let auditOk = true;
let auditManyOk = true;
let limited = false;
let rlsSeesContact = true;
let sessionRole = 'admin';
let liveProfile: Record<string, unknown> = { role: 'admin', is_active: true, locked_until: null };
const events: string[] = [];
const audits: { action: string; entityId?: string; detail?: Record<string, unknown> }[] = [];
const auditBatches: { action: string; entityId?: string }[][] = [];
const claims: { op: string; limits: unknown }[] = [];
const rpcCalls: { owner: string; fn: string; args: Record<string, unknown> }[] = [];
let rpcAnswers: Record<string, { data: unknown; error: unknown }> = {};
let mergedInto: string | null = null;
let notesCount = 1;
let leadsCount = 1;
const orders: string[] = [];
const limits: Record<string, number> = {};
const backfillCalls: { batch: unknown; tenantId: unknown }[] = [];

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
  writeAuditMany: async (_sb: unknown, _auth: unknown, entries: { action: string }[]) => {
    events.push('audit-many');
    auditBatches.push(entries);
    return auditManyOk;
  },
}));
vi.mock('@/lib/crypto/pii', () => ({
  encryptPII: async (v: string) => `enc:${v}`,
  decryptPII: async (v: string) => {
    if (!v.startsWith('enc:')) throw new Error('bad ciphertext');
    return v.slice(4);
  },
}));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));
vi.mock('@/lib/crm/indexBackfill', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/crm/indexBackfill')>('@/lib/crm/indexBackfill');
  return {
    ...actual,
    runLeadIndexBackfill: async (
      _sb: unknown,
      _key: unknown,
      batch: unknown,
      run: ReturnType<typeof actual.newIndexRun>,
      tenantId: unknown,
    ) => {
      events.push('backfill');
      backfillCalls.push({ batch, tenantId });
      run.indexed = 2;
      return run;
    },
  };
});
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

/** What a list read answers, poisoned with fields no answer may pass on. */
function listRows(table: string, owner: string): Record<string, unknown>[] {
  if (table === 'crm_contact_channels') {
    return owner === 'svc'
      ? [
          {
            id: OTHER,
            kind: 'email',
            is_primary: true,
            source: 'lead',
            value_enc: 'enc:sara@acme.sa',
          },
          { id: NOTE, kind: 'phone', is_primary: true, source: 'manual', value_enc: 'garbled' },
        ]
      : [
          {
            id: OTHER,
            kind: 'email',
            is_primary: true,
            source: 'lead',
            value_hmac: 'a'.repeat(64),
          },
        ];
  }
  if (table === 'leads') {
    return Array.from({ length: leadsCount }, (_, i) => ({
      id: i === 0 ? OTHER : `lead-${i}`,
      lead_number: 7 + i,
      name: 'Sara',
      email_enc: 'enc:sara@acme.sa',
    }));
  }
  if (table === 'crm_contact_notes') {
    return Array.from({ length: notesCount }, (_, i) => ({
      id: i === 0 ? NOTE : `note-${i}`,
      body: 'Prefers WhatsApp',
      created_by: USER,
      created_at: 'x',
    }));
  }
  if (table === 'profiles') return [{ id: USER, display_name: 'Amal' }];
  return [];
}

function builder(table: string, owner: 'svc' | 'rls') {
  const b: Record<string, unknown> = {};
  for (const method of ['in', 'is', 'eq']) b[method] = () => b;
  b['order'] = (column: string, options?: { ascending?: boolean }) => {
    orders.push(`${table}:${column}:${options?.ascending === false ? 'desc' : 'asc'}`);
    return b;
  };
  b['limit'] = (n: number) => {
    limits[table] = n;
    return b;
  };
  b['update'] = () => {
    events.push(`${owner}:update:${table}`);
    return b;
  };
  b['select'] = () => b;
  b['insert'] = () => {
    events.push(`${owner}:insert:${table}`);
    return b;
  };
  b['single'] = async () => ({ data: { id: NOTE, created_at: 'now' }, error: null });
  b['maybeSingle'] = async () => {
    events.push(`${owner}:${table}`);
    if (table === 'profiles') return { data: liveProfile, error: null };
    if (table === 'crm_contacts' && !rlsSeesContact) return { data: null, error: null };
    return {
      data: {
        id: CONTACT,
        display_name: 'Sara',
        company_name: 'Acme',
        locale: 'ar',
        version: 3,
        merged_into: mergedInto,
      },
      error: null,
    };
  };
  b['then'] = (ok: (v: unknown) => unknown) => {
    events.push(`${owner}:list:${table}`);
    return Promise.resolve({ data: listRows(table, owner), error: null }).then(ok);
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

function ctx(
  path: string,
  method = 'GET',
  body?: unknown,
  params: Record<string, string> = {},
): APIContext {
  const url = new URL(`https://admin.example.test${path}`);
  return {
    request: new Request(url, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    }),
    url,
    params: { id: CONTACT, ...params },
    locals: {
      session: { userId: USER, tenantId: TENANT, role: sessionRole, email: 'a@x', isActive: true },
      supabase: client('rls'),
    },
  } as unknown as APIContext;
}

async function data(res: Response): Promise<unknown> {
  return ((await res.json()) as { data: unknown }).data;
}

/** Fails when any key or value of `value`, at any depth, is a contact detail. */
function expectNoContactDetail(value: unknown) {
  const text = JSON.stringify(value);
  for (const secret of SECRET_VALUES) expect(text, `leaked ${secret}`).not.toContain(secret);
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, inner] of Object.entries(v)) {
        expect(SECRET_KEYS, `leaked the key ${k}`).not.toContain(k);
        walk(inner);
      }
    }
  };
  walk(value);
}

const reveal = await import('@/pages/api/admin/crm/contacts/[id]/reveal');
const notes = await import('@/pages/api/admin/crm/contacts/[id]/notes');
const detail = await import('@/pages/api/admin/crm/contacts/[id]');
const timeline = await import('@/pages/api/admin/crm/contacts/[id]/timeline');
const query = await import('@/pages/api/admin/crm/contacts/query');
const lookup = await import('@/pages/api/admin/crm/contacts/lookup');
const bulk = await import('@/pages/api/admin/crm/contacts/bulk');
const erase = await import('@/pages/api/admin/crm/contacts/[id]/erase');
const newLead = await import('@/pages/api/admin/crm/contacts/[id]/leads');
const add = await import('@/pages/api/admin/crm/contacts/index');
const noteDelete = await import('@/pages/api/admin/crm/contacts/[id]/notes/[noteId]');
const erasePreview = await import('@/pages/api/admin/crm/contacts/[id]/erase-preview');
const links = await import('@/pages/api/admin/crm/contacts/[id]/links');
const summary = await import('@/pages/api/admin/crm/contacts/summary');
const { PII_REVEAL_LIMITS, MANUAL_LEAD_LIMITS, CRM_ERASE_LIMITS } =
  await import('@/lib/admin/rateLimit');
const { validateCustomValues } = await import('@/lib/crm/contactCustom');

beforeEach(() => {
  auditOk = true;
  auditManyOk = true;
  limited = false;
  rlsSeesContact = true;
  sessionRole = 'admin';
  liveProfile = { role: 'admin', is_active: true, locked_until: null };
  events.length = 0;
  audits.length = 0;
  auditBatches.length = 0;
  claims.length = 0;
  rpcCalls.length = 0;
  rpcAnswers = {};
  mergedInto = null;
  notesCount = 1;
  leadsCount = 1;
  orders.length = 0;
  for (const key of Object.keys(limits)) delete limits[key];
  backfillCalls.length = 0;
});

describe('POST /[id]/reveal', () => {
  it('live recheck, the shared limiter, RLS read, written audit, then the ciphertext', async () => {
    const res = await reveal.POST(ctx(`/api/admin/crm/contacts/${CONTACT}/reveal`, 'POST'));
    expect(res.status).toBe(200);
    expect(events).toEqual([
      'svc:profiles',
      'ops:pii-reveal',
      'rls:crm_contacts',
      'audit:crm.contact.view_pii',
      'svc:list:crm_contact_channels',
    ]);
    // One allowance with the lead reveal: the same key, the reveal's numbers.
    expect(claims).toEqual([{ op: 'pii-reveal', limits: PII_REVEAL_LIMITS }]);
    expect(await data(res)).toEqual({
      channels: [
        { id: OTHER, kind: 'email', isPrimary: true, source: 'lead', value: 'sara@acme.sa' },
        // A value that will not decrypt is null, never the ciphertext.
        { id: NOTE, kind: 'phone', isPrimary: true, source: 'manual', value: null },
      ],
    });
    expect(audits[0]).toMatchObject({
      action: 'crm.contact.view_pii',
      entityId: CONTACT,
      detail: { pii: true, fields: ['emails', 'phones'] },
    });
  });

  it('refuses with 403 and reads no ciphertext when the audit row is not written', async () => {
    auditOk = false;
    const res = await reveal.POST(ctx(`/api/admin/crm/contacts/${CONTACT}/reveal`, 'POST'));
    expect(res.status).toBe(403);
    expect(events).not.toContain('svc:list:crm_contact_channels');
    expect(JSON.stringify(await res.json())).not.toContain('sara@acme.sa');
  });

  it('answers 429 past the limit, before any read', async () => {
    limited = true;
    const res = await reveal.POST(ctx(`/api/admin/crm/contacts/${CONTACT}/reveal`, 'POST'));
    expect(res.status).toBe(429);
    expect(events).toEqual(['svc:profiles', 'ops:pii-reveal']);
  });

  it('answers 403 to a demoted, switched-off or locked profile, before the limiter', async () => {
    for (const profile of [
      { role: 'seo', is_active: true, locked_until: null },
      { role: 'admin', is_active: false, locked_until: null },
      { role: 'admin', is_active: true, locked_until: '2999-01-01T00:00:00Z' },
    ]) {
      liveProfile = profile;
      events.length = 0;
      const res = await reveal.POST(ctx(`/api/admin/crm/contacts/${CONTACT}/reveal`, 'POST'));
      expect(res.status).toBe(403);
      expect(events).toEqual(['svc:profiles']);
    }
  });

  it('answers 404 for a contact the caller cannot see, before the audit row', async () => {
    rlsSeesContact = false;
    const res = await reveal.POST(ctx(`/api/admin/crm/contacts/${CONTACT}/reveal`, 'POST'));
    expect(res.status).toBe(404);
    expect(events).not.toContain('audit:crm.contact.view_pii');
  });
});

describe('/[id]/notes', () => {
  it('GET: a written audit row before the notes are read; refused without it', async () => {
    const res = await notes.GET(ctx(`/api/admin/crm/contacts/${CONTACT}/notes`));
    expect(res.status).toBe(200);
    expect(events).toEqual([
      'svc:profiles',
      'ops:contact-notes-read',
      'rls:crm_contacts',
      'audit:crm.contact.view_notes',
      'svc:list:crm_contact_notes',
      'svc:list:profiles',
    ]);
    expect(claims[0]!.limits).toBe(PII_REVEAL_LIMITS);

    auditOk = false;
    events.length = 0;
    const refused = await notes.GET(ctx(`/api/admin/crm/contacts/${CONTACT}/notes`));
    expect(refused.status).toBe(403);
    expect(events).not.toContain('svc:list:crm_contact_notes');
  });
});

describe('answers without contact details', () => {
  it('the list and the picker pass on the safe fields only', async () => {
    const poisoned = {
      id: CONTACT,
      display_name: 'Sara',
      stage: 'client',
      has_email: true,
      email: 'sara@acme.sa',
      phone: '+966500000000',
      value_hmac: 'a'.repeat(64),
      email_enc: 'enc:sara@acme.sa',
    };
    rpcAnswers['crm_contacts_list'] = { data: { total: 1, rows: [poisoned] }, error: null };
    const list = await query.POST(
      ctx('/api/admin/crm/contacts/query', 'POST', { q: 'Sara', stage: 'client' }),
    );
    expect(list.status).toBe(200);
    const listBody = (await data(list)) as { rows: Record<string, unknown>[] };
    expect(listBody.rows[0]).toMatchObject({ id: CONTACT, display_name: 'Sara', has_email: true });
    expectNoContactDetail(listBody);

    const picker = await lookup.POST(ctx('/api/admin/crm/contacts/lookup', 'POST', { q: 'Sara' }));
    const pickerBody = (await data(picker)) as { contacts: Record<string, unknown>[] };
    expect(Object.keys(pickerBody.contacts[0]!).sort()).toEqual(
      ['company_name', 'display_name', 'id', 'stage'].sort(),
    );
    expectNoContactDetail(pickerBody);
  });

  it('a searched e-mail reaches the database as its blind index, never as the address', async () => {
    rpcAnswers['crm_contacts_list'] = { data: { total: 0, rows: [] }, error: null };
    const res = await query.POST(
      ctx('/api/admin/crm/contacts/query', 'POST', { q: 'Sara@Acme.sa' }),
    );
    expect(res.status).toBe(200);
    const filter = rpcCalls[0]!.args['p_filter'] as Record<string, unknown>;
    expect(filter['contact_kind']).toBe('email');
    expect(filter['contact_hmac']).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rpcCalls)).not.toMatch(/acme/i);

    const half = await query.POST(ctx('/api/admin/crm/contacts/query', 'POST', { q: 'sara@' }));
    expect(half.status).toBe(422);
  });

  it('the detail and the timeline carry presence and metadata only', async () => {
    const event = {
      src: 'contact',
      id: 5,
      at: '2026-11-01T10:00:00Z',
      actor_id: USER,
      kind: 'note_added',
      detail: { note_id: NOTE },
      lead_id: null,
      lead_number: null,
      body: 'Prefers WhatsApp',
    };
    rpcAnswers['crm_contact_timeline'] = {
      data: {
        events: [event],
        next: { before: '2026-11-01T10:00:00Z', before_src: 'contact', before_id: 5 },
      },
      error: null,
    };
    const res = await detail.GET(ctx(`/api/admin/crm/contacts/${CONTACT}`));
    expect(res.status).toBe(200);
    const body = (await data(res)) as Record<string, unknown>;
    expectNoContactDetail(body);
    expect(body['channels']).toEqual([
      { id: OTHER, kind: 'email', is_primary: true, source: 'lead' },
    ]);
    const { body: _words, ...metadata } = event;
    expect(body['timeline']).toEqual({
      events: [metadata],
      next: { before: '2026-11-01T10:00:00Z', beforeSrc: 'contact', beforeId: 5 },
    });

    const page = await timeline.GET(
      ctx(
        `/api/admin/crm/contacts/${CONTACT}/timeline?kind=notes&before=2026-11-01T10:00:00Z&beforeSrc=contact&beforeId=5`,
      ),
    );
    expect(page.status).toBe(200);
    expectNoContactDetail(await data(page));
    expect(rpcCalls.at(-1)!.args['p_filter']).toEqual({
      kind: 'notes',
      before: '2026-11-01T10:00:00Z',
      before_src: 'contact',
      before_id: 5,
    });
  });
});

describe('custom field values (crm.md §5.1)', () => {
  // C9b: the three kinds CRM settings define (text, number, date).
  const fields = [
    { key: 'seats', label: 'Seats', type: 'number' as const },
    { key: 'met_on', label: 'Met on', type: 'date' as const },
    { key: 'nick', label: 'Nickname', type: 'text' as const },
  ];
  it('accepts values that fit and empties', () => {
    expect(
      validateCustomValues(fields, {
        seats: 12.5,
        met_on: '2026-03-01',
        // An empty value clears the field.
        nick: null,
      }),
    ).toBeTruthy();
  });
  it.each([
    [{ unknown_key: 'x' }, 'unknown key'],
    [{ seats: '2026' }, 'type'],
    [{ seats: 1e16 }, 'past 10^15'],
    [{ met_on: '01/03/2026' }, 'date shape'],
    [{ met_on: '2026-02-30' }, 'no such day'],
    [{ nick: 'x'.repeat(501) }, 'too long'],
    [{ nick: 'two\nlines' }, 'a control character'],
    [{ nick: 5 }, 'type'],
  ])('refuses %j (%s)', (values: Record<string, unknown>, _why: string) => {
    expect(() => validateCustomValues(fields, values as never)).toThrow();
  });
  it('refuses a value no field defines, before writing anything', async () => {
    const res = await detail.PATCH(
      ctx(`/api/admin/crm/contacts/${CONTACT}`, 'PATCH', { version: 3, custom: { a: 'x' } }),
    );
    expect(res.status).toBe(422);
    expect(events.some((e) => e.startsWith('rls:update'))).toBe(false);
  });
});

describe('POST /bulk', () => {
  it('one audit row per changed contact and one for the batch, in one insert', async () => {
    rpcAnswers['crm_contacts_bulk_update'] = {
      data: [
        { contact_id: CONTACT, contact_version: 4, outcome: 'applied' },
        { contact_id: OTHER, contact_version: 9, outcome: 'conflict' },
        { contact_id: NOTE, contact_version: null, outcome: 'missing' },
      ],
      error: null,
    };
    const res = await bulk.POST(
      ctx('/api/admin/crm/contacts/bulk', 'POST', {
        action: 'stage',
        value: 'client',
        items: [
          { id: CONTACT, version: 3 },
          { id: OTHER, version: 8 },
          { id: NOTE, version: 1 },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(rpcCalls[0]).toMatchObject({ owner: 'rls', fn: 'crm_contacts_bulk_update' });
    expect(auditBatches).toHaveLength(1);
    expect(auditBatches[0]!.map((e) => [e.action, e.entityId ?? null])).toEqual([
      ['crm.contact.update', CONTACT],
      ['crm.contact.bulk', null],
    ]);
    expect(await data(res)).toEqual({
      applied: [{ id: CONTACT, version: 4 }],
      conflicts: [{ id: OTHER, version: 9 }],
      missing: [NOTE],
      skipped: [],
      audited: true,
    });
  });
});

describe('POST /[id]/erase', () => {
  it('runs the privileged order and records the counts', async () => {
    rpcAnswers['crm_erase_person'] = {
      data: { contacts: 1, leads: 2, phone_leads: 1, channels: 3, name: 'Sara' },
      error: null,
    };
    const res = await erase.POST(
      ctx(`/api/admin/crm/contacts/${CONTACT}/erase`, 'POST', {
        reason: 'dsar',
        extraLeads: [OTHER],
      }),
    );
    expect(res.status).toBe(200);
    expect(events).toEqual([
      'svc:profiles',
      'ops:crm-erase',
      'rls:crm_contacts',
      'audit:crm.erase.attempt',
      // (Admin v2 C16) the person's file paths (their tombstones, then their files: none), read
      // before the door; nothing is removed before it (C16 review, C16-SEC-1).
      'svc:list:crm_contacts',
      'svc:list:crm_contact_files',
      'svc:rpc:crm_erase_person',
      'audit:crm.erase.outcome',
    ]);
    expect(claims[0]!.limits).toBe(CRM_ERASE_LIMITS);
    expect(rpcCalls[0]!.args).toEqual({
      p_tenant: TENANT,
      p_contact: CONTACT,
      p_extra_leads: [OTHER],
      p_actor: USER,
    });
    // Counts only: a name the door answered is not passed on.
    expect(audits[1]!.detail).toEqual({
      target: 'contact',
      status: 'ok',
      reason: 'dsar',
      contacts: 1,
      leads: 2,
      phone_leads: 1,
      channels: 3,
      files: 0,
    });
  });

  it('is refused before the door when the attempt row is not written', async () => {
    auditOk = false;
    const res = await erase.POST(
      ctx(`/api/admin/crm/contacts/${CONTACT}/erase`, 'POST', { reason: 'dsar' }),
    );
    expect(res.status).toBe(403);
    expect(rpcCalls).toEqual([]);
  });
});

describe('writes that carry a person’s details', () => {
  it('a new lead for a contact sends no contact detail and shares the manual-add limit', async () => {
    rpcAnswers['crm_contact_new_lead'] = { data: { id: OTHER, link: 'staff' }, error: null };
    const res = await newLead.POST(
      ctx(`/api/admin/crm/contacts/${CONTACT}/leads`, 'POST', {
        message: 'Wants a brand refresh',
        channel: 'phone',
        budgetBand: 'gt_200k',
      }),
    );
    expect(res.status).toBe(200);
    expect(claims).toEqual([{ op: 'lead-manual-add', limits: MANUAL_LEAD_LIMITS }]);
    const call = rpcCalls.find((c) => c.fn === 'crm_contact_new_lead')!;
    expect(call.owner).toBe('svc');
    const lead = call.args['p_lead'] as Record<string, unknown>;
    // The contact's name, company and language as defaults; the budget encrypted.
    expect(lead).toMatchObject({ name: 'Sara', company: 'Acme', locale: 'ar' });
    expect(lead['budget_enc']).toBe('enc:gt_200k');
    for (const key of ['email_enc', 'phone_enc', 'email_hmac', 'phone_hmac', 'source']) {
      expect(lead, key).not.toHaveProperty(key);
    }
  });

  it('a contact added by hand reaches the door as ciphertext and an index', async () => {
    rpcAnswers['crm_create_contact'] = { data: { id: CONTACT }, error: null };
    const res = await add.POST(
      ctx('/api/admin/crm/contacts', 'POST', {
        displayName: 'Sara',
        channels: [
          { kind: 'email', value: 'Sara@Acme.sa' },
          { kind: 'phone', value: '0500000000' },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const channels = (rpcCalls[0]!.args['p_contact'] as { channels: Record<string, unknown>[] })
      .channels;
    expect(channels.map((c) => [c['kind'], c['value_enc']])).toEqual([
      ['email', 'enc:Sara@Acme.sa'],
      ['phone', 'enc:0500000000'],
    ]);
    for (const channel of channels) expect(channel['value_hmac']).toMatch(/^[0-9a-f]{64}$/);
    // Kinds and counts in the audit row, never what was typed.
    expect(audits).toEqual([
      {
        action: 'crm.contact.create',
        entityType: 'contact',
        entityId: CONTACT,
        detail: { source: 'manual', emails: 1, phones: 1 },
      },
    ]);
    expect(JSON.stringify(rpcCalls[0]!.args)).not.toMatch(/"Sara@Acme\.sa"/);
  });

  it('a taken e-mail is a 409 naming the other contact, audited with its id only', async () => {
    rpcAnswers['crm_create_contact'] = { data: { duplicate: OTHER }, error: null };
    const res = await add.POST(
      ctx('/api/admin/crm/contacts', 'POST', {
        displayName: 'Sara',
        channels: [{ kind: 'email', value: 'sara@acme.sa' }],
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: 'duplicate', contactId: OTHER });
    expect(audits).toEqual([
      {
        action: 'crm.contact.create.duplicate',
        entityType: 'contact',
        entityId: OTHER,
        detail: { matches: [OTHER] },
      },
    ]);
  });
});

describe('DELETE /[id]/notes/[noteId] (C6 review, C6-COR-2)', () => {
  const del = () =>
    noteDelete.DELETE(
      ctx(`/api/admin/crm/contacts/${CONTACT}/notes/${NOTE}`, 'DELETE', undefined, {
        noteId: NOTE,
      }),
    );

  it('live recheck, RLS read, a written attempt row, the door, then the outcome', async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(events).toEqual([
      'svc:profiles',
      'rls:crm_contacts',
      'audit:crm.contact.note.delete.attempt',
      'svc:rpc:crm_delete_contact_note',
      'audit:crm.contact.note.delete.outcome',
    ]);
    expect(rpcCalls[0]!.args).toEqual({
      p_tenant: TENANT,
      p_contact: CONTACT,
      p_note: NOTE,
      p_actor: USER,
    });
    expect(audits[1]!.detail).toEqual({ note: NOTE, status: 'ok' });
  });

  it('is refused, and the door never called, when the attempt row is not written', async () => {
    auditOk = false;
    const res = await del();
    expect(res.status).toBe(403);
    expect(rpcCalls).toEqual([]);
  });

  it.each([
    ['P0002', 404, 'not_found'],
    ['42501', 403, 'refused'],
  ])('a door refusal %s is a %i with an outcome row saying %s', async (code, status, said) => {
    rpcAnswers['crm_delete_contact_note'] = { data: null, error: { code } };
    const res = await del();
    expect(res.status).toBe(status);
    expect(audits.map((a) => a.action)).toEqual([
      'crm.contact.note.delete.attempt',
      'crm.contact.note.delete.outcome',
    ]);
    expect(audits[1]!.detail).toEqual({ note: NOTE, status: said, code });
  });
});

describe('POST /[id]/erase-preview (C6 review, C6-SEC-2, C6-COR-2)', () => {
  const preview = () =>
    erasePreview.POST(ctx(`/api/admin/crm/contacts/${CONTACT}/erase-preview`, 'POST'));

  it('is a POST only: a GET never runs the backfill', () => {
    expect('GET' in erasePreview).toBe(false);
  });

  it('live recheck, its own limit, RLS read, the backfill for this tenant, then the door', async () => {
    rpcAnswers['crm_erase_preview'] = {
      data: {
        leads: 2,
        unindexed: 0,
        channels: 3,
        notes: 1,
        name: 'Sara',
        phone_matches: [
          {
            id: OTHER,
            lead_number: 9,
            name: 'Desk',
            company: null,
            created_at: 'x',
            email: 'e',
            tasks: 2,
          },
        ],
      },
      error: null,
    };
    const res = await preview();
    expect(res.status).toBe(200);
    expect(events.slice(0, 5)).toEqual([
      'svc:profiles',
      'ops:crm-erase-preview',
      'rls:crm_contacts',
      'backfill',
      'svc:rpc:crm_erase_preview',
    ]);
    expect(claims).toEqual([{ op: 'crm-erase-preview', limits: CRM_ERASE_LIMITS }]);
    // One batch, of the caller's own tenant only.
    expect(backfillCalls).toEqual([{ batch: undefined, tenantId: TENANT }]);
    expect(rpcCalls.at(-1)!.args).toEqual({ p_tenant: TENANT, p_contact: CONTACT, p_actor: USER });
    expect(await data(res)).toEqual({
      // (C8) tasks: the door's answer here names none, so the route says 0.
      counts: { leads: 2, unindexed: 0, channels: 3, notes: 1, tasks: 0, files: 0 },
      // (C8 review, C8-SEC-4) Each match says how many of its own tasks go if it is ticked.
      phoneMatches: [
        {
          id: OTHER,
          lead_number: 9,
          name: 'Desk',
          company: null,
          created_at: 'x',
          linked: false,
          tasks: 2,
        },
      ],
    });
  });

  it('answers 429 past its limit, before the backfill', async () => {
    limited = true;
    const res = await preview();
    expect(res.status).toBe(429);
    expect(events).toEqual(['svc:profiles', 'ops:crm-erase-preview']);
  });

  it('a contact the caller cannot see is a 404 before the backfill', async () => {
    rlsSeesContact = false;
    const res = await preview();
    expect(res.status).toBe(404);
    expect(backfillCalls).toEqual([]);
  });

  it.each([
    ['P0002', 404],
    ['42501', 403],
  ])('a door refusal %s is a %i', async (code, status) => {
    rpcAnswers['crm_erase_preview'] = { data: null, error: { code } };
    const res = await preview();
    expect(res.status).toBe(status);
  });
});

describe('POST /[id]/links (C6 review, C6-SEC-3, C6-COR-2)', () => {
  it('confirm: the door as the service role, what it copied, audited by kind', async () => {
    rpcAnswers['crm_contact_link_lead'] = {
      data: { link: 'staff', email: 'full', phone: 'kept' },
      error: null,
    };
    const res = await links.POST(
      ctx(`/api/admin/crm/contacts/${CONTACT}/links`, 'POST', {
        leadId: OTHER,
        action: 'confirm',
      }),
    );
    expect(res.status).toBe(200);
    expect(events.slice(0, 3)).toEqual([
      'svc:profiles',
      'rls:crm_contacts',
      'svc:rpc:crm_contact_link_lead',
    ]);
    expect(rpcCalls[0]).toEqual({
      owner: 'svc',
      fn: 'crm_contact_link_lead',
      args: {
        p_tenant: TENANT,
        p_contact: CONTACT,
        p_lead: OTHER,
        p_action: 'confirm',
        p_actor: USER,
      },
    });
    // A full contact copied no e-mail, and the screen is told so.
    expect(await data(res)).toEqual({ link: 'staff', email: 'full', phone: 'kept' });
    expect(audits).toEqual([
      {
        action: 'crm.contact.link',
        entityType: 'contact',
        entityId: CONTACT,
        detail: { lead: OTHER, action: 'confirm', email: 'full', phone: 'kept' },
      },
    ]);
    // An Admin may export every lead's details anyway: its confirm spends no reveal slot.
    expect(claims).toEqual([]);
  });

  // Admin v2 C10b (crm.md §10, C6-SEC-3): one reveal stays one person. A confirm copies the
  // lead's e-mail and phone into the contact the next reveal decrypts, so a role that cannot
  // export (Sales) spends a slot of the reveal's own limiter for it.
  describe('Sales (C10b): a confirm spends a reveal slot', () => {
    const asSales = () => {
      sessionRole = 'sales';
      liveProfile = { role: 'sales', is_active: true, locked_until: null };
    };
    const post = (action: 'confirm' | 'detach') =>
      links.POST(
        ctx(`/api/admin/crm/contacts/${CONTACT}/links`, 'POST', { leadId: OTHER, action }),
      );

    it('the live recheck, then the pii-reveal slot, then the read and the door', async () => {
      asSales();
      rpcAnswers['crm_contact_link_lead'] = {
        data: { link: 'staff', email: 'added', phone: 'kept' },
        error: null,
      };
      const res = await post('confirm');
      expect(res.status).toBe(200);
      expect(events.slice(0, 4)).toEqual([
        'svc:profiles',
        'ops:pii-reveal',
        'rls:crm_contacts',
        'svc:rpc:crm_contact_link_lead',
      ]);
      expect(claims).toEqual([{ op: 'pii-reveal', limits: PII_REVEAL_LIMITS }]);
      expect(audits.map((a) => a.action)).toEqual(['crm.contact.link']);
    });

    it('past the limit: a 429, nothing read, nothing copied, nothing audited', async () => {
      asSales();
      limited = true;
      const res = await post('confirm');
      expect(res.status).toBe(429);
      expect(events).not.toContain('rls:crm_contacts');
      expect(rpcCalls).toEqual([]);
      expect(audits).toEqual([]);
    });

    it('a detach copies nothing and spends no slot', async () => {
      asSales();
      rpcAnswers['crm_contact_link_lead'] = { data: { link: 'detached' }, error: null };
      const res = await post('detach');
      expect(res.status).toBe(200);
      expect(claims).toEqual([]);
    });

    it('a Sales profile demoted since the token was issued is refused before any slot', async () => {
      sessionRole = 'sales';
      liveProfile = { role: 'content_creator', is_active: true, locked_until: null };
      const res = await post('confirm');
      expect(res.status).toBe(403);
      expect(claims).toEqual([]);
      expect(rpcCalls).toEqual([]);
    });
  });

  it('a lead that is not this contact’s phone match is a 422', async () => {
    rpcAnswers['crm_contact_link_lead'] = { data: null, error: { code: '22023' } };
    const res = await links.POST(
      ctx(`/api/admin/crm/contacts/${CONTACT}/links`, 'POST', {
        leadId: OTHER,
        action: 'detach',
      }),
    );
    expect(res.status).toBe(422);
    expect(audits).toEqual([]);
  });
});

describe('PATCH /[id] (C6 review, C6-SEC-4, C6-COR-2)', () => {
  const patch = (body: unknown) =>
    detail.PATCH(ctx(`/api/admin/crm/contacts/${CONTACT}`, 'PATCH', body));

  it('channels reach the door sealed, at the version read, live-rechecked', async () => {
    rpcAnswers['crm_edit_contact_channels'] = { data: { added: 1, removed: 1 }, error: null };
    const res = await patch({
      version: 3,
      channels: { add: [{ kind: 'email', value: 'Sara@Acme.sa' }], remove: [OTHER] },
    });
    expect(res.status).toBe(200);
    expect(events.slice(0, 3)).toEqual([
      'svc:profiles',
      'rls:crm_contacts',
      'svc:rpc:crm_edit_contact_channels',
    ]);
    const call = rpcCalls.find((c) => c.fn === 'crm_edit_contact_channels')!;
    expect(call.owner).toBe('svc');
    const { p_add: added, ...rest } = call.args;
    expect(rest).toEqual({
      p_tenant: TENANT,
      p_contact: CONTACT,
      p_version: 3,
      p_remove: [OTHER],
      p_primary: [],
      p_actor: USER,
    });
    const sealed = added as Record<string, unknown>[];
    expect(sealed).toHaveLength(1);
    expect(Object.keys(sealed[0]!).sort()).toEqual(
      ['is_primary', 'kind', 'value_enc', 'value_hmac'].sort(),
    );
    expect(sealed[0]).toMatchObject({ kind: 'email', value_enc: 'enc:Sara@Acme.sa' });
    expect(sealed[0]!['value_hmac']).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(call.args)).not.toMatch(/"Sara@Acme\.sa"/);
    expect(audits[0]!.detail).toEqual({ fields: ['channels'], added: 1, removed: 1, primary: 0 });
  });

  it.each([
    ['a taken e-mail', { data: { duplicate: OTHER }, error: null }, 422],
    ['a moved version', { data: null, error: { code: '40001' } }, 409],
    [
      'an eleventh e-mail',
      {
        data: null,
        error: {
          code: '23514',
          message:
            'a contact keeps at most ten e-mails and ten phones (constraint "crm_contact_channels_cap")',
        },
      },
      422,
    ],
  ])('%s is refused with its own status, and audited nothing', async (_what, answer, status) => {
    rpcAnswers['crm_edit_contact_channels'] = answer;
    const res = await patch({
      version: 3,
      channels: { add: [{ kind: 'email', value: 'x@y.sa' }] },
    });
    expect(res.status).toBe(status);
    expect(audits).toEqual([]);
    if (answer.error?.code === '23514') {
      expect(JSON.stringify(await res.json())).toContain('up to 10 e-mail addresses');
    }
  });

  // C10b review, C10B-SEC-2: removing an e-mail or phone deletes a person's details, so it is
  // erasure's (crm.erase, Admin); Sales adds and makes primary.
  describe('Sales (C10b review): a removal is erasure, refused', () => {
    const asSales = () => {
      sessionRole = 'sales';
      liveProfile = { role: 'sales', is_active: true, locked_until: null };
    };

    it('a removal is a 403 before anything is read, written or audited', async () => {
      asSales();
      rpcAnswers['crm_edit_contact_channels'] = { data: { added: 0, removed: 1 }, error: null };
      const res = await patch({ version: 3, channels: { remove: [OTHER] } });
      expect(res.status).toBe(403);
      expect(events).toEqual([]);
      expect(rpcCalls).toEqual([]);
      expect(audits).toEqual([]);
    });

    it('a removal sent with an add is refused whole', async () => {
      asSales();
      const res = await patch({
        version: 3,
        channels: { add: [{ kind: 'phone', value: '+966501234567' }], remove: [OTHER] },
      });
      expect(res.status).toBe(403);
      expect(rpcCalls).toEqual([]);
    });

    it('an add and a new main still reach the door', async () => {
      asSales();
      rpcAnswers['crm_edit_contact_channels'] = { data: { added: 1, removed: 0 }, error: null };
      const res = await patch({
        version: 3,
        channels: { add: [{ kind: 'phone', value: '+966501234567' }], primary: [OTHER] },
      });
      expect(res.status).toBe(200);
      const call = rpcCalls.find((c) => c.fn === 'crm_edit_contact_channels')!;
      expect(call.args['p_remove']).toEqual([]);
      expect(call.args['p_primary']).toEqual([OTHER]);
    });

    it('the door’s own refusal of a removal is a 403, audited nothing', async () => {
      // An Admin demoted between the live recheck and the door: the database's
      // app.crm_eraser_ok refuses it.
      rpcAnswers['crm_edit_contact_channels'] = { data: null, error: { code: '42501' } };
      const res = await patch({ version: 3, channels: { remove: [OTHER] } });
      expect(res.status).toBe(403);
      expect(audits).toEqual([]);
    });
  });

  it('details and channels in one request are a 422, before anything is read', async () => {
    const res = await patch({ version: 3, displayName: 'Sara S', channels: { remove: [OTHER] } });
    expect(res.status).toBe(422);
    expect(events).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });

  it('a merge tombstone’s details are a 404, and nothing is written', async () => {
    mergedInto = OTHER;
    const res = await patch({ version: 3, displayName: 'Sara S' });
    expect(res.status).toBe(404);
    expect(events).not.toContain('rls:update:crm_contacts');
  });
});

describe('POST /summary (C6 review, C6-COR-2)', () => {
  it('passes on the named counts only, as the caller', async () => {
    rpcAnswers['crm_contact_summary'] = {
      data: { total: 2, lead: 1, client: 1, starred: 'x', rows: [{ email: 'sara@acme.sa' }] },
      error: null,
    };
    const res = await summary.POST(ctx('/api/admin/crm/contacts/summary', 'POST', {}));
    expect(res.status).toBe(200);
    expect(rpcCalls[0]).toEqual({
      owner: 'rls',
      fn: 'crm_contact_summary',
      args: { p_tenant: TENANT },
    });
    expect(await data(res)).toEqual({
      total: 2,
      lead: 1,
      client: 1,
      past: 0,
      partner: 0,
      starred: 0,
      mine: 0,
      expiring: 0,
      to_check: 0,
    });
  });
});

describe('notes and leads in a total order, with `more` (C6 review, C6-COR-7)', () => {
  it('the notes: newest first, ties by id, 200 a read and `more` past them', async () => {
    notesCount = 201;
    const res = await notes.GET(ctx(`/api/admin/crm/contacts/${CONTACT}/notes`));
    expect(res.status).toBe(200);
    const body = (await data(res)) as { notes: unknown[]; more: boolean };
    expect(body.notes).toHaveLength(200);
    expect(body.more).toBe(true);
    expect(orders.filter((o) => o.startsWith('crm_contact_notes:'))).toEqual([
      'crm_contact_notes:created_at:desc',
      'crm_contact_notes:id:desc',
    ]);
    expect(limits['crm_contact_notes']).toBe(201);

    notesCount = 200;
    const all = await notes.GET(ctx(`/api/admin/crm/contacts/${CONTACT}/notes`));
    expect(((await data(all)) as { more: boolean }).more).toBe(false);
  });

  it('the detail’s leads: newest first, ties by id, 50 and `moreLeads` past them', async () => {
    leadsCount = 51;
    const res = await detail.GET(ctx(`/api/admin/crm/contacts/${CONTACT}`));
    expect(res.status).toBe(200);
    const body = (await data(res)) as { leads: unknown[]; moreLeads: boolean };
    expect(body.leads).toHaveLength(50);
    expect(body.moreLeads).toBe(true);
    expect(orders.filter((o) => o.startsWith('leads:'))).toEqual([
      'leads:created_at:desc',
      'leads:id:desc',
    ]);
    expect(limits['leads']).toBe(51);
  });
});
