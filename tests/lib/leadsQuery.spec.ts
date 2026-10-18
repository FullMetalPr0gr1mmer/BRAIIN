import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIContext } from 'astro';

// The CRM read side (Admin v2 C2a): a whole e-mail or phone search becomes a blind-index
// lookup, so the address never reaches the database; the responses carry the safe fields
// only, whatever an RPC returned; a refused filter is a 422.

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';

vi.mock('@/lib/leads/interestLabel', () => ({
  resolveLeadInterests: async () => new Map(),
  withInterestLabels: (r: Record<string, unknown>) => r,
}));

const {
  toRpcFilter,
  pick,
  LEAD_CARD_FIELDS,
  LEAD_LIST_FIELDS,
  UNREADABLE_EMAIL,
  UNREADABLE_PHONE,
} = await import('@/lib/crm/leadQuery');
const { blindIndex } = await import('@/lib/crm/blindIndex');
const { LEAD_PII_ENC_KEY } = await import('astro:env/server');
const query = await import('@/pages/api/admin/leads/query');
const board = await import('@/pages/api/admin/leads/board');
const summary = await import('@/pages/api/admin/leads/summary');

const KEY = 'test-root-key';
const STAGE = '33333333-3333-4333-8333-333333333333';
const OTHER_STAGE = '44444444-4444-4444-8444-444444444444';
const PERSON = '22222222-2222-4222-8222-222222222222';
const sa = async () => 'SA';

/** Every key that must never leave the server in a CRM read response. */
const FORBIDDEN = [
  'email_enc',
  'phone_enc',
  'budget_enc',
  'timeline_band',
  'timeline_text_enc',
  'internal_notes',
  'ip_inet',
  'email_hmac',
  'phone_hmac',
  'score_signals',
  'search_text',
  'retention_delete_after',
  'retention_before_spam',
  // C4a: nothing gated, no note and no tag leaves a read route (tags are the detail's).
  'email',
  'phone',
  'budget',
  'timeline',
  'notes',
  'tags',
];

let rpcCalls: { fn: string; args: { p_tenant?: string; p_filter: Record<string, unknown> } }[] = [];
let rpcResult: { data: unknown; error: { code?: string; message?: string } | null } = {
  data: null,
  error: null,
};

function ctx(path: string, body: unknown): APIContext {
  const url = new URL(`https://www.braiinstation.com${path}`);
  const sb = {
    rpc: async (fn: string, args: { p_tenant?: string; p_filter: Record<string, unknown> }) => {
      rpcCalls.push({ fn, args });
      return rpcResult;
    },
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) b[m] = () => b;
      b['maybeSingle'] = async () => ({ data: { address_country: 'SA' }, error: null });
      return b;
    },
  };
  return {
    request: new Request(url, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    url,
    params: {},
    locals: {
      session: { userId: USER, tenantId: TENANT, role: 'admin', email: 'a@x', isActive: true },
      supabase: sb,
    },
  } as unknown as APIContext;
}

const leaky = {
  id: 'l1',
  lead_number: 7,
  name: 'Sara',
  company: 'Acme',
  message_preview: 'We need a logo',
  stage_id: 's1',
  is_spam: false,
  score: 25,
  created_at: '2026-10-01T10:00:00Z',
  version: 2,
  total: 1,
  email_enc: 'ciphertext',
  email_hmac: 'a'.repeat(64),
  score_signals: ['budget_given'],
  search_text: 'sara acme we need a logo',
  internal_notes: 'Called back',
  email: 'sara@acme.sa',
  phone: '+966500000000',
  budget: 'gt_200k',
  timeline: 'soon',
  notes: ['x'],
  tags: ['VIP'],
  phone_hmac: 'b'.repeat(64),
  // C4a's pipeline fields, which the list and the board carry
  assigned_to: '22222222-2222-4222-8222-222222222222',
  value_sar: 50000,
  is_starred: true,
  read_at: null,
  last_contact_at: null,
  last_contact_channel: null,
  over_sla: true,
};

beforeEach(() => {
  rpcCalls = [];
  rpcResult = { data: null, error: null };
});

describe('toRpcFilter: a whole address or number is a blind-index lookup', () => {
  it('an e-mail search sends its HMAC, never the address', async () => {
    const filter = await toRpcFilter(KEY, TENANT, { q: '  Sara@Acme.SA ' }, sa);
    expect(filter).toEqual({
      contact_kind: 'email',
      contact_hmac: await blindIndex(KEY, 'email', TENANT, 'sara@acme.sa'),
    });
    expect(JSON.stringify(filter)).not.toContain('acme');
  });

  it('a phone search, in any digits, sends its HMAC', async () => {
    const expected = await blindIndex(KEY, 'phone', TENANT, '+966501234567');
    expect(await toRpcFilter(KEY, TENANT, { q: '050 123 4567' }, sa)).toEqual({
      contact_kind: 'phone',
      contact_hmac: expected,
    });
    expect((await toRpcFilter(KEY, TENANT, { q: '٠٥٠١٢٣٤٥٦٧' }, sa))['contact_hmac']).toBe(
      expected,
    );
  });

  it('anything else is a "contains" search, cleaned', async () => {
    expect(await toRpcFilter(KEY, TENANT, { q: ' logo\u0000 design ', sort: 'score' }, sa)).toEqual(
      {
        q: 'logo design',
        sort: 'score',
      },
    );
    // Too few digits for a phone, and not an address: words.
    expect(await toRpcFilter(KEY, TENANT, { q: '2026' }, sa)).toEqual({ q: '2026' });
    expect(await toRpcFilter(KEY, TENANT, { q: 'L12 phase 2' }, sa)).toEqual({ q: 'L12 phase 2' });
  });

  // D10: a term that looks like an address or a number but cannot be read as one is
  // refused, never sent to the database as text (where it could reach a statement log).
  it('an address or number it cannot read is a 422, never a text search', async () => {
    const gb = async () => 'GB';
    for (const [term, country, detail] of [
      ['sara@acme.sa.', sa, UNREADABLE_EMAIL], // a trailing dot from a copy-paste
      ['sara@', sa, UNREADABLE_EMAIL], // half an address
      ['@acme.sa', sa, UNREADABLE_EMAIL],
      ['971501234567', sa, UNREADABLE_PHONE], // an international number without + or 00
      ['07700 900123', gb, UNREADABLE_PHONE], // a country the normaliser has no code for
    ] as const) {
      await expect(toRpcFilter(KEY, TENANT, { q: term }, country), term).rejects.toMatchObject({
        status: 422,
        detail,
        field: 'q',
      });
    }
  });

  it('drops empty and unset keys, and maps perStage', async () => {
    expect(
      await toRpcFilter(KEY, TENANT, { q: '   ', limit: undefined, perStage: 10 }, sa),
    ).toEqual({ per_stage: 10 });
  });
});

describe('the read routes', () => {
  it('the list returns safe fields only, whatever the RPC sent', async () => {
    rpcResult = { data: { total: 1, rows: [leaky] }, error: null };
    const res = await query.POST(ctx('/api/admin/leads/query', { q: 'Sara@Acme.SA' }));
    const body = (await res.json()) as { data: { rows: Record<string, unknown>[]; total: number } };
    expect(res.status).toBe(200);
    expect(body.data.total).toBe(1);
    expect(Object.keys(body.data.rows[0]!).sort()).toEqual([...LEAD_LIST_FIELDS].sort());
    // C4a: the pipeline fields come through, the SLA flag with them.
    expect(body.data.rows[0]).toMatchObject({
      assigned_to: PERSON,
      value_sar: 50000,
      is_starred: true,
      over_sla: true,
    });
    for (const key of FORBIDDEN) expect(JSON.stringify(body), key).not.toContain(`"${key}"`);
    // The search went as a blind index, for the caller's own tenant.
    expect(rpcCalls[0]!.fn).toBe('leads_list');
    expect(rpcCalls[0]!.args).toEqual({
      p_tenant: TENANT,
      p_filter: {
        contact_kind: 'email',
        contact_hmac: await blindIndex(LEAD_PII_ENC_KEY, 'email', TENANT, 'sara@acme.sa'),
      },
    });
  });

  it('a page past the end is empty, with the total the database counted', async () => {
    rpcResult = { data: { total: 49, rows: [] }, error: null };
    const res = await query.POST(ctx('/api/admin/leads/query', { limit: 25, offset: 50 }));
    const body = (await res.json()) as { data: { rows: unknown[]; total: number } };
    expect(body.data).toMatchObject({ rows: [], total: 49, offset: 50 });
  });

  it('a search that only looks like an address is a 422, and the database is never asked', async () => {
    const res = await query.POST(ctx('/api/admin/leads/query', { q: 'sara@acme.sa.' }));
    expect(res.status).toBe(422);
    expect(rpcCalls).toHaveLength(0);
    const board_ = await board.POST(ctx('/api/admin/leads/board', { q: '971501234567' }));
    expect(board_.status).toBe(422);
    expect(rpcCalls).toHaveLength(0);
  });

  it('the board returns safe card fields only, and each column value', async () => {
    rpcResult = {
      data: [{ stage_id: 's1', total: 1, leads: [leaky], value_sum: '50000', leak: 'x' }],
      error: null,
    };
    const res = await board.POST(ctx('/api/admin/leads/board', { perStage: 5 }));
    const body = (await res.json()) as {
      data: { columns: Record<string, unknown>[] };
    };
    expect(res.status).toBe(200);
    const column = body.data.columns[0]!;
    expect(Object.keys(column).sort()).toEqual(['leads', 'stage_id', 'total', 'value_sum']);
    expect(column['value_sum']).toBe(50000);
    const card = (column['leads'] as Record<string, unknown>[])[0]!;
    expect(card['name']).toBe('Sara');
    expect(Object.keys(card).sort()).toEqual([...LEAD_CARD_FIELDS].sort());
    expect(card).toMatchObject({ value_sar: 50000, is_starred: true, assigned_to: PERSON });
    for (const key of [...FORBIDDEN, 'message_preview', 'total', 'over_sla']) {
      expect(card, key).not.toHaveProperty(key);
    }
    for (const key of FORBIDDEN) expect(JSON.stringify(body), key).not.toContain(`"${key}"`);
    expect(rpcCalls[0]!.args).toEqual({ p_tenant: TENANT, p_filter: { per_stage: 5 } });
  });

  it('a column the database answered without a value reads 0', async () => {
    rpcResult = { data: [{ stage_id: 's1', total: 0, leads: [] }], error: null };
    const res = await board.POST(ctx('/api/admin/leads/board', {}));
    const body = (await res.json()) as { data: { columns: Record<string, unknown>[] } };
    expect(body.data.columns[0]!['value_sum']).toBe(0);
  });

  it("C4a's filters reach the readers as sent ('me' is the database's to resolve)", async () => {
    rpcResult = { data: { total: 0, rows: [] }, error: null };
    const listed = {
      assigned: 'me',
      starred: true,
      unread: false,
      source: 'manual',
      channel: 'phone',
      discipline: 'branding',
      sort: 'starred',
    };
    expect((await query.POST(ctx('/api/admin/leads/query', listed))).status).toBe(200);
    expect(rpcCalls[0]!.args).toEqual({ p_tenant: TENANT, p_filter: listed });
    rpcCalls = [];
    rpcResult = { data: [], error: null };
    const boarded = {
      assigned: PERSON,
      source: 'web_form',
      channel: 'unknown',
      discipline: 'events',
    };
    expect((await board.POST(ctx('/api/admin/leads/board', boarded))).status).toBe(200);
    expect(rpcCalls[0]!.args).toEqual({ p_tenant: TENANT, p_filter: boarded });
    rpcCalls = [];
    expect((await board.POST(ctx('/api/admin/leads/board', { assigned: 'none' }))).status).toBe(
      200,
    );
    expect(rpcCalls[0]!.args).toEqual({ p_tenant: TENANT, p_filter: { assigned: 'none' } });
  });

  it('a filter value outside its list is a 422, and the database is never asked', async () => {
    for (const body of [
      { assigned: 'x' },
      { assigned: 'ME' },
      { source: 'web' },
      { channel: 'fax' },
      { discipline: 'Bad Slug' },
      { discipline: 'a'.repeat(65) },
      { sort: 'name' },
      { starred: 'yes' },
    ]) {
      rpcCalls = [];
      const res = await query.POST(ctx('/api/admin/leads/query', body));
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(rpcCalls).toHaveLength(0);
    }
    // The board takes no stage, spam flag, sort, page, star or read mark.
    for (const body of [
      { stage: STAGE },
      { spam: true },
      { sort: 'newest' },
      { limit: 5 },
      { starred: true },
      { unread: true },
    ]) {
      rpcCalls = [];
      const res = await board.POST(ctx('/api/admin/leads/board', body));
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(rpcCalls).toHaveLength(0);
    }
  });

  it('the summary returns the counts and nothing else', async () => {
    rpcResult = {
      data: {
        total: 4,
        new: 1,
        open: 2,
        won: 1,
        lost: 1,
        spam: 4,
        avg_first_response_hours: null,
        in_progress: 1,
        won_value: 50000,
        unread: 2,
        starred: 1,
        sla_breached: 1,
        web_response_hours: 3.5,
        web_response_n: 2,
        per_stage: { [STAGE]: 3, 'not-a-stage': 9, [OTHER_STAGE]: 'x' },
        leak: 'x',
        email: 'sara@acme.sa',
      },
      error: null,
    };
    const res = await summary.POST(ctx('/api/admin/leads/summary', {}));
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toEqual({
      total: 4,
      new: 1,
      open: 2,
      won: 1,
      lost: 1,
      spam: 4,
      avg_first_response_hours: null,
      // C4a (0063)
      in_progress: 1,
      won_value: 50000,
      unread: 2,
      starred: 1,
      sla_breached: 1,
      web_response_hours: 3.5,
      web_response_n: 2,
      conversion: 0.25,
      per_stage: { [STAGE]: 3, [OTHER_STAGE]: 0 },
      // No range, so nothing to compare with: no second read, no invented delta.
      previous: null,
    });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]!.args).toEqual({ p_tenant: TENANT, p_filter: {} });
  });

  it('with a range, the summary reads the previous period of equal length too', async () => {
    rpcResult = { data: { total: 2, won: 1, new: 1 }, error: null };
    const res = await summary.POST(
      ctx('/api/admin/leads/summary', {
        from: '2026-10-08T21:00:00.000Z',
        to: '2026-10-15T21:00:00.000Z',
      }),
    );
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(rpcCalls.map((c) => c.args)).toEqual([
      {
        p_tenant: TENANT,
        p_filter: { from: '2026-10-08T21:00:00.000Z', to: '2026-10-15T21:00:00.000Z' },
      },
      {
        p_tenant: TENANT,
        p_filter: { from: '2026-10-01T21:00:00.000Z', to: '2026-10-08T21:00:00.000Z' },
      },
    ]);
    expect(body.data['previous']).toMatchObject({ total: 2, won: 1, conversion: 0.5 });
    expect(body.data['previous']).not.toHaveProperty('per_stage');
    // An open range has no equal period before it: one read.
    rpcCalls = [];
    await summary.POST(ctx('/api/admin/leads/summary', { from: '2026-10-08T21:00:00.000Z' }));
    expect(rpcCalls).toHaveLength(1);
  });

  it('the summary takes a date range only', async () => {
    for (const body of [{ assigned: 'me' }, { starred: true }, { stage: STAGE }]) {
      rpcCalls = [];
      expect((await summary.POST(ctx('/api/admin/leads/summary', body))).status).toBe(422);
      expect(rpcCalls).toHaveLength(0);
    }
  });

  it('a filter the database refuses is a 422, and an unknown key never reaches it', async () => {
    rpcResult = { data: null, error: { code: '22023', message: 'lead filter: unknown key' } };
    expect((await query.POST(ctx('/api/admin/leads/query', { sort: 'newest' }))).status).toBe(422);
    rpcCalls = [];
    expect((await query.POST(ctx('/api/admin/leads/query', { email: 'x' }))).status).toBe(422);
    expect(rpcCalls).toHaveLength(0);
  });

  it('pick keeps listed fields and nulls the missing ones', () => {
    expect(pick({ id: 'x', secret: 'y' }, ['id', 'name'] as const)).toEqual({
      id: 'x',
      name: null,
    });
  });
});
