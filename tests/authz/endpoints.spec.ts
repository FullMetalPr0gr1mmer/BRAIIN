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
    body: { slug: 'logo', title: VALID_BILINGUAL, status: 'draft' },
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
  // ---- Round 2 (0028): disciplines and service cases — service content (§5 Services) ----
  {
    name: 'disciplines list',
    load: () => import('@/pages/api/admin/disciplines/index'),
    method: 'GET',
    url: '/api/admin/disciplines?status.neq=archived',
    // SEO: the service form's Discipline picker (it reads services for their meta).
    allow: ['admin', 'content_creator', 'seo'],
  },
  {
    name: 'disciplines create',
    load: () => import('@/pages/api/admin/disciplines/index'),
    method: 'POST',
    url: '/api/admin/disciplines',
    body: { slug: 'branding', name: VALID_BILINGUAL, status: 'draft' },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'disciplines read one',
    load: () => import('@/pages/api/admin/disciplines/[id]'),
    method: 'GET',
    url: `/api/admin/disciplines/${UUID}`,
    allow: ['admin', 'content_creator', 'seo'],
  },
  {
    name: 'disciplines publish (status transition)',
    load: () => import('@/pages/api/admin/disciplines/[id]'),
    method: 'PATCH',
    url: `/api/admin/disciplines/${UUID}`,
    body: { status: 'published', name: VALID_BILINGUAL, version: 1 },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'disciplines archive (Admin-only — hides every service under it)',
    load: () => import('@/pages/api/admin/disciplines/[id]'),
    method: 'PATCH',
    url: `/api/admin/disciplines/${UUID}`,
    body: { status: 'archived', version: 1 },
    allow: ['admin'],
  },
  {
    name: 'disciplines delete',
    load: () => import('@/pages/api/admin/disciplines/[id]'),
    method: 'DELETE',
    url: `/api/admin/disciplines/${UUID}`,
    allow: ['admin'],
  },
  {
    name: 'disciplines reorder',
    load: () => import('@/pages/api/admin/disciplines/reorder'),
    method: 'POST',
    url: '/api/admin/disciplines/reorder',
    body: { items: [{ id: UUID, sortOrder: 10 }] },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'service cases list',
    load: () => import('@/pages/api/admin/service-cases/index'),
    method: 'GET',
    url: '/api/admin/service-cases',
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'service cases create',
    load: () => import('@/pages/api/admin/service-cases/index'),
    method: 'POST',
    url: '/api/admin/service-cases',
    body: { serviceId: UUID, portfolioId: UUID, title: VALID_BILINGUAL },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'service cases read one',
    load: () => import('@/pages/api/admin/service-cases/[id]'),
    method: 'GET',
    url: `/api/admin/service-cases/${UUID}`,
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'service cases publish',
    load: () => import('@/pages/api/admin/service-cases/[id]'),
    method: 'PATCH',
    url: `/api/admin/service-cases/${UUID}`,
    body: { status: 'published', version: 1 },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'service cases archive (Admin-only transition)',
    load: () => import('@/pages/api/admin/service-cases/[id]'),
    method: 'PATCH',
    url: `/api/admin/service-cases/${UUID}`,
    body: { status: 'archived', version: 1 },
    allow: ['admin'],
  },
  {
    name: 'service cases delete',
    load: () => import('@/pages/api/admin/service-cases/[id]'),
    method: 'DELETE',
    url: `/api/admin/service-cases/${UUID}`,
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

  // ---- UI v2 content model (PR4b) ----
  {
    name: 'portfolio create (save_portfolio)',
    load: () => import('@/pages/api/admin/portfolio/index'),
    method: 'POST',
    url: '/api/admin/portfolio',
    body: { slug: 'the-rider', title: VALID_BILINGUAL, status: 'draft' },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'portfolio publish',
    load: () => import('@/pages/api/admin/portfolio/[id]'),
    method: 'PATCH',
    url: `/api/admin/portfolio/${UUID}`,
    body: { status: 'published', version: 1 },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'portfolio services-only update (child set)',
    load: () => import('@/pages/api/admin/portfolio/[id]'),
    method: 'PATCH',
    url: `/api/admin/portfolio/${UUID}`,
    body: { serviceIds: [UUID], version: 1 },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'portfolio delete',
    load: () => import('@/pages/api/admin/portfolio/[id]'),
    method: 'DELETE',
    url: `/api/admin/portfolio/${UUID}`,
    allow: ['admin'],
  },
  {
    name: 'sectors list',
    load: () => import('@/pages/api/admin/sectors/index'),
    method: 'GET',
    url: '/api/admin/sectors',
    // SEO: the case-study editor's Industry picker.
    allow: ['admin', 'content_creator', 'seo'],
  },
  {
    name: 'clients list',
    load: () => import('@/pages/api/admin/clients/index'),
    method: 'GET',
    url: '/api/admin/clients',
    allow: ['admin', 'content_creator', 'seo'],
  },
  {
    name: 'sectors create',
    load: () => import('@/pages/api/admin/sectors/index'),
    method: 'POST',
    url: '/api/admin/sectors',
    body: { slug: 'automotive', name: VALID_BILINGUAL },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'sectors delete',
    load: () => import('@/pages/api/admin/sectors/[id]'),
    method: 'DELETE',
    url: `/api/admin/sectors/${UUID}`,
    allow: ['admin'],
  },
  {
    name: 'clients create',
    load: () => import('@/pages/api/admin/clients/index'),
    method: 'POST',
    url: '/api/admin/clients',
    body: { slug: 'neom', name: VALID_BILINGUAL },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'clients clear for disclosure (visible = publish)',
    load: () => import('@/pages/api/admin/clients/[id]'),
    method: 'PATCH',
    url: `/api/admin/clients/${UUID}`,
    body: { visible: true, version: 1 },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'testimonials create',
    load: () => import('@/pages/api/admin/testimonials/index'),
    method: 'POST',
    url: '/api/admin/testimonials',
    body: { slug: 'q', quote: VALID_BILINGUAL, authorName: VALID_BILINGUAL },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'testimonials publish',
    load: () => import('@/pages/api/admin/testimonials/[id]'),
    method: 'PATCH',
    url: `/api/admin/testimonials/${UUID}`,
    body: { status: 'published', version: 1 },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'testimonials delete',
    load: () => import('@/pages/api/admin/testimonials/[id]'),
    method: 'DELETE',
    url: `/api/admin/testimonials/${UUID}`,
    allow: ['admin'],
  },
  {
    name: 'team create (leadership fields)',
    load: () => import('@/pages/api/admin/team/index'),
    method: 'POST',
    url: '/api/admin/team',
    body: { slug: 'leader-1', name: VALID_BILINGUAL, isLeadership: true },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'statistics create (count-up value)',
    load: () => import('@/pages/api/admin/statistics/index'),
    method: 'POST',
    url: '/api/admin/statistics',
    body: { slug: 'brands', label: VALID_BILINGUAL, valueNumeric: 80, valueSuffix: '+' },
    allow: ['admin', 'content_creator'],
  },
  {
    name: 'media hard delete (media.hardDelete — Admin only)',
    load: () => import('@/pages/api/admin/media/[id]'),
    method: 'DELETE',
    url: `/api/admin/media/${UUID}`,
    allow: ['admin'],
  },
  {
    name: 'media usage',
    load: () => import('@/pages/api/admin/media/[id]/usage'),
    method: 'GET',
    url: `/api/admin/media/${UUID}/usage`,
    // Every role that may read the library: media.write full (admin, CC, developer) or meta (SEO).
    allow: ['admin', 'content_creator', 'seo', 'developer'],
  },
  {
    name: 'media metadata (SEO "meta only" path)',
    load: () => import('@/pages/api/admin/media/meta/[id]'),
    method: 'PATCH',
    url: `/api/admin/media/meta/${UUID}`,
    body: { alt: VALID_BILINGUAL, version: 1 },
    allow: ['admin', 'content_creator', 'seo', 'developer'],
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
  // Redirects: §5 grants Admin + SEO the whole module — reads, writes AND deletes (the
  // resource names `deleteCap: 'redirects.manage'`, Round 3) and the edge sync.
  {
    name: 'redirects list',
    load: () => import('@/pages/api/admin/redirects/index'),
    method: 'GET',
    url: '/api/admin/redirects',
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
  {
    name: 'redirects update',
    load: () => import('@/pages/api/admin/redirects/[id]'),
    method: 'PATCH',
    url: `/api/admin/redirects/${UUID}`,
    body: { targetPath: '/new', version: 1 },
    allow: ['admin', 'seo'],
  },
  {
    name: 'redirects delete (SEO may — not the content default)',
    load: () => import('@/pages/api/admin/redirects/[id]'),
    method: 'DELETE',
    url: `/api/admin/redirects/${UUID}`,
    allow: ['admin', 'seo'],
  },
  {
    name: 'redirects sync to edge',
    load: () => import('@/pages/api/admin/redirects/sync'),
    method: 'POST',
    url: '/api/admin/redirects/sync',
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

  // ---- Job applications (Join) — Admin only, owner decision J6 ----
  {
    name: 'applications list',
    load: () => import('@/pages/api/admin/applications/index'),
    method: 'GET',
    url: '/api/admin/applications',
    allow: ['admin'],
  },
  {
    name: 'application detail',
    load: () => import('@/pages/api/admin/applications/[id]'),
    method: 'GET',
    url: `/api/admin/applications/${UUID}`,
    allow: ['admin'],
  },
  {
    name: 'application contact details (pii)',
    load: () => import('@/pages/api/admin/applications/[id]'),
    method: 'GET',
    url: `/api/admin/applications/${UUID}?pii=1`,
    allow: ['admin'],
  },
  {
    name: 'application status / notes',
    load: () => import('@/pages/api/admin/applications/[id]'),
    method: 'PATCH',
    url: `/api/admin/applications/${UUID}`,
    body: { status: 'in_review', internalNotes: 'Strong reel' },
    allow: ['admin'],
  },
  {
    name: 'application erase',
    load: () => import('@/pages/api/admin/applications/[id]'),
    method: 'DELETE',
    url: `/api/admin/applications/${UUID}`,
    allow: ['admin'],
  },
  {
    name: 'application CV download',
    load: () => import('@/pages/api/admin/applications/[id]/cv'),
    method: 'GET',
    url: `/api/admin/applications/${UUID}/cv`,
    allow: ['admin'],
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
  // The reads behind the settings-like screens: what their forms load on mount, and what
  // tests/admin/refusals.e2e.ts asks the real stack for as each role without the capability.
  {
    name: 'general settings read',
    load: () => import('@/pages/api/admin/settings/index'),
    method: 'GET',
    url: '/api/admin/settings',
    allow: ['admin', 'developer'],
  },
  {
    name: 'integrations read',
    load: () => import('@/pages/api/admin/integrations'),
    method: 'GET',
    url: '/api/admin/integrations',
    allow: ['admin', 'seo'],
  },
  {
    name: 'theme list',
    load: () => import('@/pages/api/admin/themes/index'),
    method: 'GET',
    url: '/api/admin/themes',
    allow: ['admin', 'developer'],
  },
  {
    name: 'style-finder logic config read',
    load: () => import('@/pages/api/admin/ai-config'),
    method: 'GET',
    url: '/api/admin/ai-config',
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
  // Public identity singleton (migration 0019) — §5 "General settings": Admin + Developer.
  // (accepting_applications is narrower still — Admin only — but that is enforced by the
  // DATABASE, a 0019 trigger, and pinned by supabase/tests/rls_site_profile.test.sql.)
  {
    name: 'site profile read',
    load: () => import('@/pages/api/admin/site-profile'),
    method: 'GET',
    url: '/api/admin/site-profile',
    allow: ['admin', 'developer'],
  },
  {
    name: 'site profile write',
    load: () => import('@/pages/api/admin/site-profile'),
    method: 'PATCH',
    url: '/api/admin/site-profile',
    body: { brandName: VALID_BILINGUAL, version: 1 },
    allow: ['admin', 'developer'],
  },
  {
    // The settings form ALWAYS sends the checkbox, so an unchanged flag must not turn a
    // Developer's identity save into a 403. (The stubbed stored row has it closed.)
    name: 'site profile write, applications flag unchanged',
    load: () => import('@/pages/api/admin/site-profile'),
    method: 'PATCH',
    url: '/api/admin/site-profile',
    body: { brandName: VALID_BILINGUAL, acceptingApplications: false, version: 1 },
    allow: ['admin', 'developer'],
  },
  {
    // Opening the job-application intake is Admin-only (UI v2 decision 4). This row is
    // the WORKER layer; the 0019 guard trigger is the database layer (pgTAP).
    name: 'site profile opens job applications (Admin-only)',
    load: () => import('@/pages/api/admin/site-profile'),
    method: 'PATCH',
    url: '/api/admin/site-profile',
    body: { acceptingApplications: true, version: 1 },
    allow: ['admin'],
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
    name: 'admin search (the command palette)',
    load: () => import('@/pages/api/admin/search'),
    method: 'GET',
    url: '/api/admin/search?q=logo',
    // Any staff role: what each one FINDS is gated per entity inside searchAdmin().
    allow: ['admin', 'content_creator', 'seo', 'developer'],
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
