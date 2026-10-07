import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIRoute } from 'astro';

// A per-tenant singleton row (site_settings, site_integrations, seo_defaults, ai_config,
// site_profile) is created on its first save, never by a migration, and until then GET
// answers `version: 0` (src/lib/admin/singleton.ts). The editor sends back the version
// it was given, so the first save arrives with 0. The kernel turns 0 or 1 into the
// INSERT, but the schemas used to demand `min(1)`: every first save of SEO defaults,
// integrations, AI config, settings or maintenance was refused with a 422 before the
// kernel ran. This drives the real routes over a tenant with no row yet.

vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';

let inserts: string[] = [];

/** A tenant with no singleton row yet: every read is empty, every insert succeeds. */
function emptyTenantClient() {
  return {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'update', 'order', 'limit']) b[m] = () => b;
      b['insert'] = () => {
        inserts.push(table);
        return b;
      };
      b['maybeSingle'] = async () => ({ data: null, error: null });
      b['single'] = async () => ({ data: { version: 1 }, error: null });
      b['then'] = (ok: (v: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null }).then(ok);
      return b;
    },
  };
}

function patch(url: string, body: unknown) {
  const full = new URL(url, 'https://admin.example.test');
  return {
    request: new Request(full, {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    url: full,
    params: {},
    locals: {
      session: { userId: USER, tenantId: TENANT, role: 'admin', isActive: true, email: 'a@x.test' },
      supabase: emptyTenantClient(),
      cspNonce: 'test',
      csrfToken: 'test',
    },
  } as unknown as Parameters<APIRoute>[0];
}

const SINGLETONS: {
  name: string;
  table: string;
  url: string;
  body: Record<string, unknown>;
  load: () => Promise<Record<string, unknown>>;
}[] = [
  {
    name: 'SEO defaults',
    table: 'seo_defaults',
    url: '/api/admin/seo-defaults',
    body: {},
    load: () => import('@/pages/api/admin/seo-defaults'),
  },
  {
    name: 'integrations',
    table: 'site_integrations',
    url: '/api/admin/integrations',
    body: {},
    load: () => import('@/pages/api/admin/integrations'),
  },
  {
    name: 'AI config',
    table: 'ai_config',
    url: '/api/admin/ai-config',
    body: {},
    load: () => import('@/pages/api/admin/ai-config'),
  },
  {
    name: 'settings',
    table: 'site_settings',
    url: '/api/admin/settings',
    body: {},
    load: () => import('@/pages/api/admin/settings/index'),
  },
  {
    name: 'maintenance',
    table: 'site_settings',
    url: '/api/admin/settings/maintenance',
    body: { active: false, allowlist: [] },
    load: () => import('@/pages/api/admin/settings/maintenance'),
  },
  {
    name: 'site profile',
    table: 'site_profile',
    url: '/api/admin/site-profile',
    body: {},
    load: () => import('@/pages/api/admin/site-profile'),
  },
];

beforeEach(() => {
  inserts = [];
});

describe('the first save of a singleton (no row yet, GET said version 0)', () => {
  for (const s of SINGLETONS) {
    it(`${s.name}: version 0 creates the row`, async () => {
      const { PATCH } = (await s.load()) as { PATCH: APIRoute };
      const res = (await PATCH(patch(s.url, { ...s.body, version: 0 }))) as Response;
      expect(res.status, await res.clone().text()).toBe(200);
      expect(inserts).toContain(s.table);
    });

    it(`${s.name}: a version the missing row never had is a conflict, not a create`, async () => {
      const { PATCH } = (await s.load()) as { PATCH: APIRoute };
      const res = (await PATCH(patch(s.url, { ...s.body, version: 2 }))) as Response;
      expect(res.status).toBe(409);
      expect(inserts).not.toContain(s.table);
    });
  }
});
