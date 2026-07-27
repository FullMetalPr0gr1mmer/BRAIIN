import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIRoute } from 'astro';
import type { AuthContext, Role } from '@/lib/auth/types';
import { ROLES } from '@/lib/auth/types';

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

// ── Stubs ───────────────────────────────────────────────────────────────────────

// `liveRecheck()` and the export rate limiter read `profiles` through the SERVICE-ROLE
// client, so the stub has to answer with a profile that matches whoever is being tested
// — otherwise every privileged endpoint denies everyone and the suite passes for the
// wrong reason.
vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () =>
    makeStubClient({
      row: {
        id: UUID,
        version: 1,
        role: currentPrincipal.role,
        is_active: true,
        locked_until: null,
        tenant_id: currentPrincipal.tenantId,
      },
    }),
}));

vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async () => true,
}));

/** Tenant values seen in `.eq('tenant_id', …)` during the current request. */
let observedTenantFilters: string[] = [];

/** The principal the serviceClient stub should impersonate for live-rechecks. */
let currentPrincipal: { role: Role; tenantId: string } = { role: 'admin', tenantId: '' };

interface StubOptions {
  row?: Record<string, unknown>;
  rows?: Record<string, unknown>[];
  count?: number;
}

/**
 * A chainable PostgREST stand-in. Every terminal resolves successfully, so any non-2xx
 * this suite observes is an authorization decision rather than a data problem.
 */
function makeStubClient(options: StubOptions = {}) {
  const row = options.row ?? { id: '11111111-1111-4111-8111-111111111111', version: 1 };
  // Non-empty by default: `deleteRow` treats a DELETE that affects zero rows as an RLS
  // refusal (see crud.ts), so an empty stub would make every delete look like a 403 and
  // hide the authorization signal this suite is trying to read.
  const rows = options.rows ?? [row];
  const count = options.count ?? rows.length;

  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  for (const method of [
    'is',
    'neq',
    'gt',
    'gte',
    'lt',
    'lte',
    'ilike',
    'like',
    'order',
    'range',
    'limit',
    'in',
    'contains',
    'filter',
    'match',
    'select',
  ]) {
    builder[method] = chain;
  }
  // Records every `.eq('tenant_id', …)` the handler applies. This is what lets the
  // cross-tenant test assert something real against a stubbed database (see below).
  builder['eq'] = (column: string, value: unknown) => {
    if (column === 'tenant_id') observedTenantFilters.push(String(value));
    return builder;
  };
  for (const method of ['insert', 'update', 'delete', 'upsert']) {
    builder[method] = chain;
  }
  builder['single'] = async () => ({ data: row, error: null });
  builder['maybeSingle'] = async () => ({ data: row, error: null });
  // Awaiting the builder itself is how PostgREST list queries resolve.
  builder['then'] = (resolve: (value: unknown) => unknown) =>
    Promise.resolve(resolve({ data: rows, error: null, count }));

  return {
    from: () => builder,
    rpc: async () => ({ data: null, error: null }),
    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
      signOut: async () => ({ error: null }),
      admin: {
        inviteUserByEmail: async () => ({ data: { user: { id: row['id'] } }, error: null }),
        updateUserById: async () => ({ data: {}, error: null }),
      },
    },
  };
}

/** The two non-role principals from §9, expressed the way the server sees them. */
type Principal = Role | 'anon' | 'other_tenant';

/**
 * The per-capability rows cover the four roles plus `anon`. `other_tenant` is examined
 * separately, below, because it is a different KIND of claim: it is an admin — it holds
 * every capability — and what must stop it is the tenant predicate, not assertCap.
 * Asserting 403 for it here would be asserting that the wrong layer denies it, and
 * would pass only by accident.
 */
const PRINCIPALS: Principal[] = [...ROLES, 'anon'];

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_TENANT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UUID = '11111111-1111-4111-8111-111111111111';

function sessionFor(principal: Principal): AuthContext | null {
  if (principal === 'anon') return null;
  // `other_tenant` is a fully-privileged ADMIN whose tenant differs. Modelling it as an
  // admin is the point: if it were a weak role, a pass would prove nothing about tenant
  // isolation, only about capabilities. Every row below must still deny it — the
  // endpoints scope by `auth.tenantId`, and the stub returns rows regardless, so a
  // non-403 here means the tenant predicate is the only thing standing between tenants.
  const role: Role = principal === 'other_tenant' ? 'admin' : principal;
  return {
    userId: UUID,
    tenantId: principal === 'other_tenant' ? OTHER_TENANT : TENANT,
    role,
    isActive: true,
    email: `${principal}@example.test`,
  };
}

function makeContext(principal: Principal, url: string, body?: unknown, method = 'GET') {
  observedTenantFilters = [];
  const session = sessionFor(principal);
  currentPrincipal = {
    role: session?.role ?? 'admin',
    tenantId: session?.tenantId ?? TENANT,
  };
  const full = new URL(url, 'https://admin.example.test');
  const request = new Request(full, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
  return {
    request,
    url: full,
    params: { id: UUID },
    locals: {
      session,
      supabase: makeStubClient(),
      cspNonce: 'test',
      csrfToken: 'test',
    },
  } as unknown as Parameters<APIRoute>[0];
}

async function statusOf(route: APIRoute, ctx: Parameters<APIRoute>[0]): Promise<number> {
  const response = await route(ctx);
  return (response as Response).status;
}

// ── The matrix ──────────────────────────────────────────────────────────────────

interface Case {
  name: string;
  /** Dynamic import so a broken route file fails its own row, not the whole file. */
  load: () => Promise<Record<string, unknown>>;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  body?: unknown;
  /** Roles that must NOT get 403. Everyone else must. */
  allow: Role[];
}

const VALID_BILINGUAL = { en: 'Example', ar: 'مثال' };

const CASES: Case[] = [
  // ---- Content ----
  {
    name: 'services list',
    load: () => import('@/pages/api/admin/services/index'),
    method: 'GET',
    url: '/api/admin/services',
    // SEO reaches this through `seo.entityMeta` — it must find a service to write meta
    // for. Developer holds neither capability.
    allow: ['admin', 'content_creator', 'seo'],
  },
  {
    name: 'services create',
    load: () => import('@/pages/api/admin/services/index'),
    method: 'POST',
    url: '/api/admin/services',
    body: { slug: 'branding', title: VALID_BILINGUAL, status: 'draft' },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'services publish (status transition)',
    load: () => import('@/pages/api/admin/services/[id]'),
    method: 'PATCH',
    url: `/api/admin/services/${UUID}`,
    body: { status: 'published', title: VALID_BILINGUAL, version: 1 },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'services archive (Admin-only transition)',
    load: () => import('@/pages/api/admin/services/[id]'),
    method: 'PATCH',
    url: `/api/admin/services/${UUID}`,
    body: { status: 'archived', version: 1 },
    allow: ['admin'],
  },
  {
    name: 'services delete',
    load: () => import('@/pages/api/admin/services/[id]'),
    method: 'DELETE',
    url: `/api/admin/services/${UUID}`,
    allow: ['admin'],
  },
  {
    name: 'blog create',
    load: () => import('@/pages/api/admin/blog/index'),
    method: 'POST',
    url: '/api/admin/blog',
    body: { slug: 'a-post', title: VALID_BILINGUAL, status: 'draft' },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'navigation create',
    load: () => import('@/pages/api/admin/navigation/index'),
    method: 'POST',
    url: '/api/admin/navigation',
    body: { location: 'header', label: VALID_BILINGUAL, href: '/services' },
    allow: ['admin', 'content_creator'],
  },

  // ---- SEO ----
  {
    name: 'entity SEO read',
    load: () => import('@/pages/api/admin/entity-seo'),
    method: 'GET',
    url: `/api/admin/entity-seo?entityType=service&entityId=${UUID}`,
    // Content Creator holds 'view' on seo.entityMeta.
    allow: ['admin', 'seo', 'content_creator'],
  },
  {
    name: 'entity SEO write',
    load: () => import('@/pages/api/admin/entity-seo'),
    method: 'PUT',
    url: '/api/admin/entity-seo',
    body: {
      entityType: 'service',
      entityId: UUID,
      metaTitle: VALID_BILINGUAL,
      metaDescription: VALID_BILINGUAL,
      version: 0,
    },
    allow: ['admin', 'seo'],
  },
  {
    name: 'global SEO defaults write',
    load: () => import('@/pages/api/admin/seo-defaults'),
    method: 'PATCH',
    url: '/api/admin/seo-defaults',
    body: { robotsDirectives: 'index,follow', version: 1 },
    allow: ['admin', 'seo'],
  },
  {
    name: 'redirects create',
    load: () => import('@/pages/api/admin/redirects/index'),
    method: 'POST',
    url: '/api/admin/redirects',
    body: { sourcePath: '/old', targetPath: '/new', status: 301 },
    allow: ['admin', 'seo'],
  },

  // ---- Leads / PII ----
  {
    name: 'leads list',
    load: () => import('@/pages/api/admin/leads/index'),
    method: 'GET',
    url: '/api/admin/leads',
    allow: ['admin', 'developer'],
  },
  {
    name: 'lead detail',
    load: () => import('@/pages/api/admin/leads/[id]'),
    method: 'GET',
    url: `/api/admin/leads/${UUID}`,
    allow: ['admin', 'developer'],
  },
  {
    name: 'lead CSV export',
    load: () => import('@/pages/api/admin/leads/export'),
    method: 'GET',
    url: '/api/admin/leads/export',
    allow: ['admin', 'developer'],
  },

  // ---- System ----
  {
    name: 'user list',
    load: () => import('@/pages/api/admin/users/index'),
    method: 'GET',
    url: '/api/admin/users',
    allow: ['admin'],
  },
  {
    name: 'user invite',
    load: () => import('@/pages/api/admin/users/index'),
    method: 'POST',
    url: '/api/admin/users',
    body: { email: 'new@example.test', role: 'seo' },
    allow: ['admin'],
  },
  {
    name: 'general settings write',
    load: () => import('@/pages/api/admin/settings/index'),
    method: 'PATCH',
    url: '/api/admin/settings',
    body: { identity: {}, version: 1 },
    allow: ['admin', 'developer'],
  },
  {
    name: 'integrations write',
    load: () => import('@/pages/api/admin/integrations'),
    method: 'PATCH',
    url: '/api/admin/integrations',
    body: { ga4: {}, version: 1 },
    allow: ['admin', 'seo'],
  },
  {
    name: 'maintenance toggle',
    load: () => import('@/pages/api/admin/settings/maintenance'),
    method: 'PATCH',
    url: '/api/admin/settings/maintenance',
    body: { active: true, allowlist: ['203.0.113.4'], version: 1 },
    allow: ['admin', 'developer'],
  },
  {
    name: 'page visibility toggle',
    load: () => import('@/pages/api/admin/pages/visibility/[id]'),
    method: 'PATCH',
    url: `/api/admin/pages/visibility/${UUID}`,
    body: { navVisible: false, version: 1 },
    allow: ['admin', 'developer'],
  },
  {
    name: 'theme write',
    load: () => import('@/pages/api/admin/themes/index'),
    method: 'POST',
    url: '/api/admin/themes',
    body: { name: 'Neon', tokens: { '--ad-accent': '#00e5ff' } },
    allow: ['admin', 'developer'],
  },
  {
    name: 'system logs read',
    load: () => import('@/pages/api/admin/logs'),
    method: 'GET',
    url: '/api/admin/logs',
    allow: ['admin', 'developer'],
  },
  {
    name: 'system logs clear',
    load: () => import('@/pages/api/admin/logs'),
    method: 'DELETE',
    url: '/api/admin/logs?olderThanDays=30',
    allow: ['admin'],
  },
  {
    name: 'audit log read',
    load: () => import('@/pages/api/admin/audit'),
    method: 'GET',
    url: '/api/admin/audit',
    allow: ['admin', 'developer'],
  },
  {
    name: 'site health',
    load: () => import('@/pages/api/admin/site-health'),
    method: 'GET',
    url: '/api/admin/site-health',
    allow: ['admin', 'developer'],
  },
  {
    name: 'backup export',
    load: () => import('@/pages/api/admin/export-backup'),
    method: 'GET',
    url: '/api/admin/export-backup',
    allow: ['admin', 'developer'],
  },
  {
    name: 'analytics dashboards',
    load: () => import('@/pages/api/admin/analytics/index'),
    method: 'GET',
    url: '/api/admin/analytics',
    // The one capability all four roles hold.
    allow: ['admin', 'content_creator', 'seo', 'developer'],
  },
  {
    name: 'search analytics',
    load: () => import('@/pages/api/admin/analytics/search'),
    method: 'GET',
    url: '/api/admin/analytics/search',
    allow: ['admin', 'seo', 'developer'],
  },

  // ---- AI Style-Finder ----
  {
    name: 'style-finder question create',
    load: () => import('@/pages/api/admin/ai-questions/index'),
    method: 'POST',
    url: '/api/admin/ai-questions',
    body: { slug: 'vibe', prompt: VALID_BILINGUAL },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'style-finder logic config',
    load: () => import('@/pages/api/admin/ai-config'),
    method: 'PATCH',
    url: '/api/admin/ai-config',
    body: { dailyUsdCap: 5, version: 1 },
    // Admin ALONE — Content Creator authors questions but does not tune the model.
    allow: ['admin'],
  },
];

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
    const listCases = CASES.filter((c) => c.method === 'GET' && !c.url.includes('export'));
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
