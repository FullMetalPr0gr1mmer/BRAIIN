import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import type { AuthContext } from '@/lib/auth/types';

// Check now's route (Admin v2 G2, POST /api/admin/site-health/check): another tenant gets a
// 409 before anything is read or claimed; the rate limit is claimed before the probes run,
// answers 429 with Retry-After past it and fails closed when its ledger cannot be read; the
// probes run forced, as the service role, for the caller's tenant; the answer is the GET
// twin's three readings, when, and which reads failed. No audit row (decision D7).

const state = vi.hoisted(() => ({
  launch: 'tenant-1' as string | null,
  ledger: 'ok' as 'ok' | 'over' | 'down',
  claims: [] as { op: string }[],
  runs: [] as { tenant: string; options: Record<string, unknown> }[],
  audits: 0,
}));

vi.mock('@/lib/data/tenant', () => ({ resolveLaunchTenantId: async () => state.launch }));
vi.mock('@/lib/supabase/server', () => ({ serviceClient: () => ({ service: true }) }));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));
vi.mock('@/lib/admin/audit', () => ({
  writeAudit: async () => {
    state.audits += 1;
  },
}));
vi.mock('@/lib/admin/rateLimit', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/admin/rateLimit')>();
  const { RateLimitError } = await import('@/lib/admin/errors');
  return {
    ...real,
    claimPrivilegedOp: async (_auth: AuthContext, op: string) => {
      state.claims.push({ op });
      if (state.ledger === 'over') throw new RateLimitError(`${op}:user`);
      if (state.ledger === 'down') throw new RateLimitError(`${op}:unavailable`);
    },
  };
});
vi.mock('@/lib/health/probes', () => ({
  runHealthProbes: async (_sb: unknown, tenant: string, options: Record<string, unknown>) => {
    state.runs.push({ tenant, options });
    return {
      rows: [
        {
          kind: 'uptime',
          state: 'off',
          facts: {},
          read_ok: false,
          failures: 0,
          checked_at: '2026-10-15T12:00:00.000Z',
          ok_at: null,
          next_at: null,
          state_since: '2026-10-15T12:00:00.000Z',
        },
        {
          kind: 'domain',
          state: 'fail',
          facts: {
            apex: 'braiinstation.com',
            outcome: 'not-found',
            expires: null,
            registrar: null,
            rdap: null,
          },
          read_ok: true,
          failures: 0,
          checked_at: '2026-10-15T12:00:00.000Z',
          ok_at: '2026-10-15T12:00:00.000Z',
          next_at: '2026-10-16T08:00:00.000Z',
          state_since: '2026-10-15T12:00:00.000Z',
        },
      ],
      ran: ['domain'],
      failed: [],
    };
  },
}));

const { POST } = (await import('@/pages/api/admin/site-health/check')) as { POST: APIRoute };
const { HEALTH_CHECK_LIMITS } = await import('@/lib/admin/rateLimit');

function call(role: AuthContext['role'], tenantId = 'tenant-1') {
  const url = new URL('https://admin.example.test/api/admin/site-health/check');
  return POST({
    request: new Request(url, { method: 'POST' }),
    url,
    params: {},
    locals: {
      session: { userId: 'u1', tenantId, role, isActive: true, email: 'a@example.test' },
      supabase: { from: () => ({}) },
    },
  } as unknown as Parameters<APIRoute>[0]) as Promise<Response>;
}

beforeEach(() => {
  state.launch = 'tenant-1';
  state.ledger = 'ok';
  state.claims = [];
  state.runs = [];
  state.audits = 0;
});

describe('POST /api/admin/site-health/check', () => {
  it('runs every probe now for the caller’s tenant and answers the readings', async () => {
    const res = await call('developer');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(state.claims).toEqual([{ op: 'health.check' }]);
    expect(state.runs).toEqual([
      {
        tenant: 'tenant-1',
        options: expect.objectContaining({ force: true, source: 'admin:health' }),
      },
    ]);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(Object.keys(body.data).sort()).toEqual([
      'certificate',
      'checkedAt',
      'domain',
      'failed',
      'uptime',
    ]);
    expect(body.data['uptime']).toEqual({
      state: 'off',
      checkedAt: '2026-10-15T12:00:00.000Z',
      okAt: null,
      facts: null,
    });
    expect(body.data['domain']).toMatchObject({
      state: 'fail',
      facts: { apex: 'braiinstation.com' },
    });
    expect(body.data['certificate']).toBeNull();
    expect(state.audits).toBe(0);
  });

  it('another tenant gets a 409 before anything is claimed or read', async () => {
    const res = await call('admin', 'tenant-2');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'single-site' });
    expect(state.claims).toEqual([]);
    expect(state.runs).toEqual([]);
    state.launch = null;
    expect((await call('admin')).status).toBe(409);
    expect(state.runs).toEqual([]);
  });

  it('past the limit: 429 with Retry-After, and nothing runs', async () => {
    expect(HEALTH_CHECK_LIMITS).toEqual({ perUser: 6, perTenant: 12, windowMinutes: 60 });
    state.ledger = 'over';
    const res = await call('admin');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3600');
    expect(state.runs).toEqual([]);
  });

  it('fails closed when the ledger cannot be read', async () => {
    state.ledger = 'down';
    const res = await call('admin');
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({
      error: 'rate-limit',
      scope: 'health.check:unavailable',
    });
    expect(state.runs).toEqual([]);
  });

  it('Content Creator and SEO are refused before anything happens', async () => {
    for (const role of ['content_creator', 'seo'] as const) {
      expect((await call(role)).status).toBe(403);
    }
    expect(state.claims).toEqual([]);
    expect(state.runs).toEqual([]);
  });
});
