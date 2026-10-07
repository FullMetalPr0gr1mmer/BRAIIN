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

const { toRpcFilter, pick, LEAD_LIST_FIELDS } = await import('@/lib/crm/leadQuery');
const { blindIndex } = await import('@/lib/crm/blindIndex');
const { LEAD_PII_ENC_KEY } = await import('astro:env/server');
const query = await import('@/pages/api/admin/leads/query');
const board = await import('@/pages/api/admin/leads/board');
const summary = await import('@/pages/api/admin/leads/summary');

const KEY = 'test-root-key';
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
];

let rpcCalls: { fn: string; args: { p_filter: Record<string, unknown> } }[] = [];
let rpcResult: { data: unknown; error: { code?: string; message?: string } | null } = {
  data: null,
  error: null,
};

function ctx(path: string, body: unknown): APIContext {
  const url = new URL(`https://www.braiinstation.com${path}`);
  const sb = {
    rpc: async (fn: string, args: { p_filter: Record<string, unknown> }) => {
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
    expect(await toRpcFilter(KEY, TENANT, { q: 'sara@' }, sa)).toEqual({ q: 'sara@' });
  });

  it('drops empty and unset keys, and maps perStage', async () => {
    expect(
      await toRpcFilter(KEY, TENANT, { q: '   ', limit: undefined, perStage: 10 }, sa),
    ).toEqual({ per_stage: 10 });
  });
});

describe('the read routes', () => {
  it('the list returns safe fields only, whatever the RPC sent', async () => {
    rpcResult = { data: [leaky], error: null };
    const res = await query.POST(ctx('/api/admin/leads/query', { q: 'Sara@Acme.SA' }));
    const body = (await res.json()) as { data: { rows: Record<string, unknown>[]; total: number } };
    expect(res.status).toBe(200);
    expect(body.data.total).toBe(1);
    expect(Object.keys(body.data.rows[0]!).sort()).toEqual([...LEAD_LIST_FIELDS].sort());
    for (const key of FORBIDDEN) expect(JSON.stringify(body), key).not.toContain(`"${key}"`);
    // The search went as a blind index.
    expect(rpcCalls[0]!.fn).toBe('leads_list');
    expect(rpcCalls[0]!.args.p_filter).toEqual({
      contact_kind: 'email',
      contact_hmac: await blindIndex(LEAD_PII_ENC_KEY, 'email', TENANT, 'sara@acme.sa'),
    });
  });

  it('the board returns safe card fields only', async () => {
    rpcResult = { data: [{ stage_id: 's1', total: 1, leads: [leaky] }], error: null };
    const res = await board.POST(ctx('/api/admin/leads/board', { perStage: 5 }));
    const body = (await res.json()) as {
      data: { columns: { leads: Record<string, unknown>[] }[] };
    };
    expect(res.status).toBe(200);
    expect(body.data.columns[0]!.leads[0]!['name']).toBe('Sara');
    for (const key of [...FORBIDDEN, 'message_preview', 'total']) {
      expect(body.data.columns[0]!.leads[0]!, key).not.toHaveProperty(key);
    }
    expect(rpcCalls[0]!.args.p_filter).toEqual({ per_stage: 5 });
  });

  it('the summary returns the counts and nothing else', async () => {
    rpcResult = {
      data: {
        total: 3,
        new: 1,
        open: 2,
        won: 0,
        lost: 1,
        spam: 4,
        avg_first_response_hours: null,
        leak: 'x',
      },
      error: null,
    };
    const res = await summary.POST(ctx('/api/admin/leads/summary', {}));
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toEqual({
      total: 3,
      new: 1,
      open: 2,
      won: 0,
      lost: 1,
      spam: 4,
      avg_first_response_hours: null,
    });
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
