import { describe, it, expect, vi } from 'vitest';

// §9(d): "notify-lead (unsigned POST → 401, no PII in body)".
//
// This endpoint is the one public URL that can read the lead table. It is
// unauthenticated by URL, discoverable, and retryable without limit — so the bearer
// check is the only thing between the internet and a lead row, and it has to be proven
// rather than assumed.

const inserted: Record<string, unknown>[] = [];

vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => {
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const m of ['select', 'eq', 'in', 'order', 'limit']) builder[m] = chain;
    builder['insert'] = (row: Record<string, unknown>) => {
      inserted.push(row);
      return Promise.resolve({ data: null, error: null });
    };
    builder['maybeSingle'] = async () => ({
      data: {
        id: 'lead-1',
        tenant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        name: 'A Person',
        message: 'hello',
        service_of_interest: 'branding',
        locale: 'en',
        email_enc: '',
        phone_enc: '',
        budget_enc: '',
        timeline_band: '3-6m',
        created_at: '2026-07-27T00:00:00Z',
      },
      error: null,
    });
    builder['then'] = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(resolve({ data: [{ id: 'u1', role: 'admin' }], error: null }));
    return { from: () => builder };
  },
}));

vi.mock('@/lib/supabase/client', () => ({
  supabaseConfigured: () => true,
  anonClient: () => ({}),
}));

vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));

const { POST } = await import('@/pages/api/hooks/notify-lead');

const VALID_TOKEN = 'test-dummy-notify-lead-secret'; // matches tests/stubs/astro-env-server.ts
const BODY = {
  lead_id: '11111111-1111-4111-8111-111111111111',
  tenant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};

function call(token: string | null, body: unknown = BODY) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers['authorization'] = token;
  const request = new Request('https://www.braiinstation.com/api/hooks/notify-lead', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return (POST as unknown as (ctx: { request: Request }) => Promise<Response>)({ request });
}

describe('notify-lead authentication', () => {
  it('rejects a POST with no Authorization header', async () => {
    expect((await call(null)).status).toBe(401);
  });

  it('rejects an empty or malformed bearer', async () => {
    expect((await call('Bearer ')).status).toBe(401);
    expect((await call('Basic abc')).status).toBe(401);
    expect((await call(VALID_TOKEN)).status).toBe(401); // no "Bearer " prefix
  });

  it('rejects a wrong token, including a prefix of the real one', async () => {
    expect((await call('Bearer wrong')).status).toBe(401);
    expect((await call(`Bearer ${VALID_TOKEN.slice(0, -1)}`)).status).toBe(401);
    expect((await call(`Bearer ${VALID_TOKEN}x`)).status).toBe(401);
  });

  it('accepts the correct token', async () => {
    expect((await call(`Bearer ${VALID_TOKEN}`)).status).toBe(200);
  });

  it('validates the payload only AFTER authenticating', async () => {
    // An unauthenticated caller must not be able to make us parse anything, and must
    // not learn the payload shape from a 422.
    expect((await call(null, { garbage: true })).status).toBe(401);
    expect((await call(`Bearer ${VALID_TOKEN}`, { garbage: true })).status).toBe(422);
  });
});

describe('notify-lead payload hygiene', () => {
  it('logs field NAMES and counts, never lead values', async () => {
    inserted.length = 0;
    await call(`Bearer ${VALID_TOKEN}`);

    const row = inserted.find((r) => 'channel' in r);
    expect(row, 'no notification_log row written').toBeDefined();

    const serialized = JSON.stringify(row);
    // The notification ledger is readable by Admin + Developer and is not covered by the
    // lead retention purge, so duplicating PII into it would create a second copy that
    // outlives the first.
    expect(serialized).not.toContain('A Person');
    expect(serialized).not.toContain('hello');
    expect(serialized).not.toContain('3-6m');
    expect(row).toMatchObject({ channel: 'inbox', status: 'queued' });
  });
});
