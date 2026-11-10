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
    return [{ id: OTHER, lead_number: 7, name: 'Sara', email_enc: 'enc:sara@acme.sa' }];
  }
  if (table === 'crm_contact_notes') {
    return [{ id: NOTE, body: 'Prefers WhatsApp', created_by: USER, created_at: 'x' }];
  }
  if (table === 'profiles') return [{ id: USER, display_name: 'Amal' }];
  return [];
}

function builder(table: string, owner: 'svc' | 'rls') {
  const b: Record<string, unknown> = {};
  for (const method of ['order', 'limit', 'in', 'is', 'eq', 'update']) b[method] = () => b;
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
        merged_into: null,
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
  const fields = [
    { key: 'budget_year', label: 'Budget year', type: 'number' as const, min: 2020, max: 2030 },
    { key: 'sector', label: 'Sector', type: 'select' as const, options: ['retail', 'food'] },
    { key: 'vip', label: 'VIP', type: 'boolean' as const },
    { key: 'met_on', label: 'Met on', type: 'date' as const },
    { key: 'nick', label: 'Nickname', type: 'text' as const, maxLength: 5 },
  ];
  it('accepts values that fit and empties', () => {
    expect(
      validateCustomValues(fields, {
        budget_year: 2026,
        sector: 'food',
        vip: true,
        met_on: '2026-03-01',
        // An empty value clears the field.
        nick: null,
      }),
    ).toBeTruthy();
  });
  it.each([
    [{ unknown_key: 'x' }, 'unknown key'],
    [{ budget_year: '2026' }, 'type'],
    [{ budget_year: 2019 }, 'below the least'],
    [{ budget_year: 2031 }, 'above the most'],
    [{ sector: 'cars' }, 'not an option'],
    [{ vip: 'yes' }, 'type'],
    [{ met_on: '01/03/2026' }, 'date shape'],
    [{ nick: 'Sarah!' }, 'too long'],
  ])('refuses %j (%s)', (values) => {
    expect(() => validateCustomValues(fields, values as never)).toThrow();
  });
  it('refuses any custom value while no fields are defined (until C9b)', async () => {
    const res = await detail.PATCH(
      ctx(`/api/admin/crm/contacts/${CONTACT}`, 'PATCH', { version: 3, custom: { a: 'x' } }),
    );
    expect(res.status).toBe(422);
    expect(events.some((e) => e.startsWith('rls:'))).toBe(false);
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
