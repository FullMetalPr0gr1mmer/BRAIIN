import { describe, it, expect, vi, beforeEach } from 'vitest';

// The contact form's per-address limit (EXC-004): over it → 429; an unreachable limiter
// FAILS OPEN — the lead is still stored.

let hit: number | 'error' = 1;
const inserts: unknown[] = [];

vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({
    rpc: async () =>
      hit === 'error' ? { data: null, error: { message: 'down' } } : { data: hit, error: null },
  }),
}));
vi.mock('@/lib/supabase/client', () => ({ supabaseConfigured: () => true }));
vi.mock('@/lib/data/tenant', () => ({
  resolveLaunchTenantId: async () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
}));
vi.mock('@/lib/data/leads', () => ({
  createLead: async (input: unknown) => {
    inserts.push(input);
    return { ok: true };
  },
}));

const { POST } = await import('@/pages/api/contact');

const send = () =>
  (POST as unknown as (c: { request: Request }) => Promise<Response>)({
    request: new Request('https://www.braiinstation.com/api/contact', {
      method: 'POST',
      headers: {
        host: 'www.braiinstation.com',
        origin: 'https://www.braiinstation.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Sam', email: 'sam@example.com', message: 'Hello.' }),
    }),
  });

beforeEach(() => {
  hit = 1;
  inserts.length = 0;
});

describe('POST /api/contact — the public write limiter', () => {
  it('under the limit: stored', async () => {
    expect((await send()).status).toBe(200);
    expect(inserts).toHaveLength(1);
  });

  it('over the limit: 429 and nothing stored', async () => {
    hit = 11;
    expect((await send()).status).toBe(429);
    expect(inserts).toHaveLength(0);
  });

  it('an unreachable limiter fails OPEN: the lead is still stored', async () => {
    hit = 'error';
    expect((await send()).status).toBe(200);
    expect(inserts).toHaveLength(1);
  });
});
