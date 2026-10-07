import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIRoute } from 'astro';

// The PII export reads leads as the service role since 0033 (staff tokens cannot read the
// gated columns at all), and the service role bypasses RLS. On that query the route's own
// `.eq('tenant_id', …)` is therefore the ONLY tenant fence: drop it and one tenant's
// export dumps every tenant's leads. Pinned here, against the real route.

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';

const serviceCalls: { table: string; method: string; args: unknown[] }[] = [];
const callerCalls: { table: string; method: string; args: unknown[] }[] = [];

function recorder(log: typeof serviceCalls, table: string) {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'lte', 'in', 'order', 'limit']) {
    b[m] = (...args: unknown[]) => {
      log.push({ table, method: m, args });
      return b;
    };
  }
  b['then'] = (ok: (v: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null, count: 0 }).then(ok);
  return b;
}

vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({ from: (table: string) => recorder(serviceCalls, table) }),
}));
vi.mock('@/lib/admin/liveRecheck', () => ({ liveRecheck: async () => undefined }));
vi.mock('@/lib/admin/rateLimit', () => ({ claimPrivilegedOp: async () => undefined }));
vi.mock('@/lib/admin/audit', () => ({ writeAudit: async () => true }));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));
vi.mock('@/lib/leads/interestLabel', () => ({
  resolveLeadInterests: async () => new Map(),
  withInterestLabels: (r: Record<string, unknown>) => r,
}));

const { GET } = await import('@/pages/api/admin/leads/export');

function call(role: string) {
  const url = new URL('https://admin.example.test/api/admin/leads/export');
  return (GET as APIRoute)({
    request: new Request(url),
    url,
    params: {},
    locals: {
      session: { userId: USER, tenantId: TENANT, role, isActive: true, email: 'x@x.test' },
      supabase: { from: (table: string) => recorder(callerCalls, table) },
      cspNonce: 'n',
      csrfToken: 'c',
    },
  } as unknown as Parameters<APIRoute>[0]) as Promise<Response>;
}

beforeEach(() => {
  serviceCalls.length = 0;
  callerCalls.length = 0;
});

describe('the PII export is fenced to the caller’s tenant (service-role read, 0033)', () => {
  for (const role of ['admin', 'developer']) {
    it(`${role}: the service-role lead query filters on the caller's tenant`, async () => {
      const res = await call(role);
      expect(res.status).toBe(200);
      const leadCalls = serviceCalls.filter((c) => c.table === 'leads');
      // The read really is the service role's (the gated columns need it)…
      expect(leadCalls.some((c) => c.method === 'select')).toBe(true);
      // …so its tenant filter is the fence, with the session's tenant, not a request value.
      expect(leadCalls).toContainEqual({ table: 'leads', method: 'eq', args: ['tenant_id', TENANT] });
      // And the caller's own client never reads the lead table on this path.
      expect(callerCalls.filter((c) => c.table === 'leads')).toEqual([]);
    });
  }
});
