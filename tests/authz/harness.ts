import type { APIRoute } from 'astro';
import type { AuthContext, Role } from '@/lib/auth/types';
import { ROLES } from '@/lib/auth/types';

// The harness of the admin authorization suite (CLAUDE.md §9): the principals, their
// sessions, a stubbed database and the request context a route handler is invoked with.
// tests/authz/endpoints.spec.ts runs the matrix with it; the cases themselves live in
// tests/authz/cases/<feature>.ts. A spec that drives route handlers mocks the two
// server-side modules itself (vi.mock is per file), as endpoints.spec.ts does:
//
//   vi.mock('@/lib/supabase/server', () => ({ serviceClient: serviceClientStub }));
//   vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));

// ── Stubs ───────────────────────────────────────────────────────────────────────

/**
 * Tenant values seen in `.eq('tenant_id', …)` during the current request. A live binding:
 * makeContext() resets it, the stub client appends to it, and a spec reads it afterwards.
 */
export let observedTenantFilters: string[] = [];

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
export function makeStubClient(options: StubOptions = {}) {
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
  // cross-tenant test assert something real against a stubbed database (see
  // endpoints.spec.ts).
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
    // An RPC that takes the tenant from the Worker (`p_tenant`) is a scoped read as much as
    // an `.eq('tenant_id', …)` is, so the scoping assertions see it too.
    rpc: async (_fn: string, args?: Record<string, unknown>) => {
      if (typeof args?.['p_tenant'] === 'string') observedTenantFilters.push(args['p_tenant']);
      return { data: null, error: null };
    },
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

/**
 * What `serviceClient()` returns under the suite's mock. `liveRecheck()` and the export
 * rate limiter read `profiles` through the SERVICE-ROLE client, so the stub has to answer
 * with a profile that matches whoever is being tested — otherwise every privileged
 * endpoint denies everyone and the suite passes for the wrong reason.
 */
export function serviceClientStub() {
  return makeStubClient({
    row: {
      id: UUID,
      version: 1,
      role: currentPrincipal.role,
      is_active: true,
      locked_until: null,
      tenant_id: currentPrincipal.tenantId,
    },
  });
}

// ── Principals ──────────────────────────────────────────────────────────────────

/** The two non-role principals from §9, expressed the way the server sees them. */
export type Principal = Role | 'anon' | 'other_tenant';

/**
 * The per-capability rows cover the four roles plus `anon`. `other_tenant` is examined
 * separately, in endpoints.spec.ts, because it is a different KIND of claim: it is an
 * admin — it holds every capability — and what must stop it is the tenant predicate, not
 * assertCap. Asserting 403 for it per row would be asserting that the wrong layer denies
 * it, and would pass only by accident.
 */
export const PRINCIPALS: Principal[] = [...ROLES, 'anon'];

export const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const OTHER_TENANT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const UUID = '11111111-1111-4111-8111-111111111111';

function sessionFor(principal: Principal): AuthContext | null {
  if (principal === 'anon') return null;
  // `other_tenant` is a fully-privileged ADMIN whose tenant differs. Modelling it as an
  // admin is the point: if it were a weak role, a pass would prove nothing about tenant
  // isolation, only about capabilities. Every row must still deny it — the endpoints
  // scope by `auth.tenantId`, and the stub returns rows regardless, so a non-403 here
  // means the tenant predicate is the only thing standing between tenants.
  const role: Role = principal === 'other_tenant' ? 'admin' : principal;
  return {
    userId: UUID,
    tenantId: principal === 'other_tenant' ? OTHER_TENANT : TENANT,
    role,
    isActive: true,
    email: `${principal}@example.test`,
  };
}

// ── Requests ────────────────────────────────────────────────────────────────────

export function makeContext(principal: Principal, url: string, body?: unknown, method = 'GET') {
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

export async function statusOf(route: APIRoute, ctx: Parameters<APIRoute>[0]): Promise<number> {
  const response = await route(ctx);
  return (response as Response).status;
}

// ── Cases ───────────────────────────────────────────────────────────────────────

/** One row of the matrix: a route, a request, and the roles that may pass assertCap. */
export interface Case {
  name: string;
  /** Dynamic import so a broken route file fails its own row, not the whole file. */
  load: () => Promise<Record<string, unknown>>;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  body?: unknown;
  /** Roles that must NOT get 403. Everyone else must. */
  allow: Role[];
  /** A read sent as a POST (its search stays out of URLs): checked for scoping like a GET. */
  read?: true;
}

export const VALID_BILINGUAL = { en: 'Example', ar: 'مثال' };
