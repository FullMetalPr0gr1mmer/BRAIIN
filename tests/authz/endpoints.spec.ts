import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIRoute } from 'astro';
import { CASES } from './cases';
import {
  OTHER_TENANT,
  PRINCIPALS,
  makeContext,
  observedTenantFilters,
  serviceClientStub,
  statusOf,
} from './harness';

// THE headline authorization suite (CLAUDE.md §9): every sensitive operation gets a row
// over `admin, content_creator, seo, developer, anon, other_tenant`, and `other_tenant`
// is deny on every row.
//
// ── Why this drives the real handlers ────────────────────────────────────────────
// A cheaper test would assert `can(role, cap)` for each endpoint's declared capability.
// That proves nothing: it re-reads the same map the endpoint reads, so an endpoint
// wired to the WRONG capability — or to none — passes with flying colours. These tests
// import the actual route modules and invoke them, so the assertion is "this URL, with
// this session, answers 403", which is the property that matters.
//
// The database is stubbed. That is deliberate and it is what makes this the SECONDARY
// layer's test: RLS is the primary layer and is proven separately in pgTAP
// (`supabase/tests/*.test.sql`), because you cannot test a Postgres policy without
// Postgres. Here every query succeeds, so a 403 can only have come from assertCap.

// ── The cases ───────────────────────────────────────────────────────────────────
// One module per admin feature, tests/authz/cases/<feature>.ts, collected by
// tests/authz/cases/index.ts; the harness (principals, sessions, the stub client) is
// tests/authz/harness.ts. A new admin route adds its rows to its feature's module: the
// completeness check (endpointCoverage.spec.ts) fails while any exported method has none.

// ── Stubs ───────────────────────────────────────────────────────────────────────

// `liveRecheck()` and the export rate limiter read `profiles` through the SERVICE-ROLE
// client, so the stub answers with a profile matching whoever is being tested (see
// serviceClientStub) — otherwise every privileged endpoint denies everyone and the suite
// passes for the wrong reason.
vi.mock('@/lib/supabase/server', () => ({ serviceClient: serviceClientStub }));

vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async () => true,
}));

// ── The matrix ──────────────────────────────────────────────────────────────────

describe('admin endpoints — {principal × capability} matrix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const testCase of CASES) {
    describe(testCase.name, () => {
      for (const principal of PRINCIPALS) {
        const shouldAllow =
          principal !== 'anon' && (testCase.allow as string[]).includes(principal);

        it(`${principal} → ${shouldAllow ? 'permitted' : '403'}`, async () => {
          const module = await testCase.load();
          const route = module[testCase.method] as APIRoute | undefined;
          expect(route, `${testCase.name} has no ${testCase.method} export`).toBeTypeOf('function');

          const ctx = makeContext(principal, testCase.url, testCase.body, testCase.method);
          const status = await statusOf(route as APIRoute, ctx);

          if (shouldAllow) {
            // Not asserting 200: a permitted call may still 409/422 against the stub.
            // The claim under test is only that authorization did not refuse it.
            expect(status, `${principal} was refused with ${status}`).not.toBe(403);
            expect(status).not.toBe(401);
          } else {
            expect(status, `${principal} reached the handler`).toBe(403);
          }
        });
      }
    });
  }

  // ── other_tenant ───────────────────────────────────────────────────────────────
  // §9 requires `other_tenant` to be DENY on every row, and it is — but the layer that
  // denies it is not this one, and a test has to be honest about which property it
  // proves. `other_tenant` here is a fully-privileged admin OF ANOTHER TENANT, so
  // assertCap correctly lets it past: it holds every capability, in its own tenant.
  // What stops it reaching this tenant's data is the tenant predicate plus RLS.
  //
  // So the assertion is the one that IS checkable without a database: every
  // tenant-scoped query a handler issues must filter on the CALLER's tenant, and the
  // caller's tenant is never taken from the request. If a handler ever read a tenant id
  // out of a path, body or query parameter, this fails. The zero-rows half is proven
  // where it lives, in pgTAP (`supabase/tests/*.test.sql`).
  it('never queries a tenant other than the caller’s own', async () => {
    for (const testCase of CASES) {
      const module = await testCase.load();
      const route = module[testCase.method] as APIRoute;
      const ctx = makeContext('other_tenant', testCase.url, testCase.body, testCase.method);
      await statusOf(route, ctx);

      const leaked = observedTenantFilters.filter((tenant) => tenant !== OTHER_TENANT);
      expect(leaked, `${testCase.name} scoped a query to a foreign tenant`).toEqual([]);
    }
  });

  it('scopes its reads to a tenant at all', async () => {
    // The companion to the test above: filtering on the right tenant is worthless if a
    // handler forgets to filter on any tenant. Checked over the list endpoints, where
    // an unscoped read would return every tenant's rows.
    const listCases = CASES.filter(
      (c) => (c.method === 'GET' || c.read) && !c.url.includes('export'),
    );
    for (const testCase of listCases) {
      const module = await testCase.load();
      const route = module[testCase.method] as APIRoute;
      const ctx = makeContext('admin', testCase.url, testCase.body, testCase.method);
      await statusOf(route, ctx);
      expect(
        observedTenantFilters.length,
        `${testCase.name} issued an unscoped read`,
      ).toBeGreaterThan(0);
    }
  });

  it('anonymous callers never reach a handler', async () => {
    for (const testCase of CASES) {
      const module = await testCase.load();
      const route = module[testCase.method] as APIRoute;
      const ctx = makeContext('anon', testCase.url, testCase.body, testCase.method);
      const status = await statusOf(route, ctx);
      expect([401, 403]).toContain(status);
    }
  });
});

// ── The search route searches as its caller ─────────────────────────────────────
// Every staff role may call it, so the matrix above proves only "not 403". What a role
// FINDS is decided per entity inside searchAdmin(), pinned role by role in
// tests/lib/globalSearch.spec.ts; this checks the route hands it the caller rather than
// anyone else. The stub answers a row from every table, so the groups are what it searched.
describe('GET /api/admin/search searches as its caller', () => {
  it.each([
    ['developer', ['Pages', 'Media', 'Themes']],
    [
      'seo',
      [
        'Disciplines',
        'Services',
        'Blog',
        'Our Work',
        'Sectors',
        'Clients',
        'Pages',
        'Categories',
        'Team & authors',
        'Redirects',
        'Media',
      ],
    ],
  ] as const)('%s', async (role, groups) => {
    const { GET } = (await import('@/pages/api/admin/search')) as { GET: APIRoute };
    const response = (await GET(makeContext(role, '/api/admin/search?q=logo'))) as Response;
    const body = (await response.json()) as { data: { groups: { group: string }[] } };
    expect(body.data.groups.map((g) => g.group)).toEqual(groups);
  });
});

// ── Database refusals after assertCap passed ─────────────────────────────────────
// A singleton write the Worker allowed can still be refused by the database: a guard
// trigger (42501) or a CHECK the PATCH could not see because it spans stored columns
// (23514). Neither is a server fault, so neither may surface as a 500.
describe('singleton writes — database refusals map to client errors', () => {
  function refusingClient(code: string) {
    let calls = 0;
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'update', 'insert']) builder[m] = () => builder;
    builder['maybeSingle'] = async () =>
      // 1st call: the version pre-read finds the row. 2nd: the UPDATE is refused.
      ++calls === 1
        ? { data: { version: 1, accepting_applications: false }, error: null }
        : { data: null, error: { code, message: 'refused' } };
    return { from: () => builder };
  }

  for (const [code, expected] of [
    ['42501', 403],
    ['23514', 422],
  ] as const) {
    it(`${code} → ${expected}`, async () => {
      const { PATCH } = await import('@/pages/api/admin/site-profile');
      const ctx = makeContext(
        'admin',
        '/api/admin/site-profile',
        { whatsappDisplay: '055 000 0000', version: 1 },
        'PATCH',
      );
      (ctx.locals as unknown as { supabase: unknown }).supabase = refusingClient(code);
      expect(await statusOf(PATCH as APIRoute, ctx)).toBe(expected);
    });
  }
});
