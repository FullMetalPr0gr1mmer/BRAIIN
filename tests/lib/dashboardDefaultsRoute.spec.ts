import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import {
  OTHER_TENANT,
  TENANT,
  makeContext,
  serviceClientStub,
  type Principal,
} from '../authz/harness';

// PUT and DELETE /api/admin/dashboard/defaults/[role] (Admin v2 U1, README U1 D1 to D3), past
// assertCap: the matrix (tests/authz/cases/dashboard.ts) proves who is refused; this proves
// what an Admin's call does once it is let through. The role comes from the path (404 for one
// that is not a role), every write is scoped to the session's tenant and never the path's or
// the body's, and the audit row names the role and the fields saved, never their values.

const audits: { action: string; entityType?: string; entityId?: string; detail?: unknown }[] = [];

vi.mock('@/lib/admin/audit', () => ({
  writeAudit: async (_sb: unknown, _auth: unknown, entry: (typeof audits)[number]) => {
    audits.push(entry);
    return true;
  },
}));
vi.mock('@/lib/supabase/server', () => ({ serviceClient: serviceClientStub }));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));

const route = (await import('@/pages/api/admin/dashboard/defaults/[role]')) as Record<
  'PUT' | 'DELETE',
  APIRoute
>;

interface Call {
  op: string;
  args: unknown[];
}

/**
 * A PostgREST stand-in that records every call. `stored` is the preset the pre-read finds
 * (null: none yet); a write answers with the row it was given.
 */
function recordingClient(stored: Record<string, unknown> | null) {
  const calls: Call[] = [];
  let written: Record<string, unknown> | null = null;
  let deleting = false;
  const builder: Record<string, unknown> = {};
  for (const op of ['select', 'eq', 'insert', 'update', 'delete']) {
    builder[op] = (...args: unknown[]) => {
      calls.push({ op, args });
      if (op === 'insert' || op === 'update') written = args[0] as Record<string, unknown>;
      if (op === 'delete') deleting = true;
      return builder;
    };
  }
  builder['maybeSingle'] = async () =>
    written
      ? {
          data: { ...stored, ...written, version: Number(stored?.['version'] ?? 0) + 1 },
          error: null,
        }
      : { data: stored, error: null };
  builder['then'] = (resolve: (value: unknown) => unknown) =>
    Promise.resolve(
      resolve({ data: deleting && stored ? [{ role: stored['role'] }] : [], error: null }),
    );
  return { client: { from: () => builder }, calls };
}

function call(
  principal: Principal,
  method: 'PUT' | 'DELETE',
  role: string,
  stored: Record<string, unknown> | null,
  body?: unknown,
) {
  const ctx = makeContext(principal, `/api/admin/dashboard/defaults/${role}`, body, method, {
    role,
  });
  const { client, calls } = recordingClient(stored);
  (ctx.locals as unknown as { supabase: unknown }).supabase = client;
  return { run: () => route[method](ctx) as Promise<Response>, calls };
}

const tenantsOf = (calls: Call[]) => [
  ...calls.filter((c) => c.op === 'eq' && c.args[0] === 'tenant_id').map((c) => c.args[1]),
  ...calls
    .filter((c) => c.op === 'insert')
    .map((c) => (c.args[0] as Record<string, unknown>)['tenant_id']),
];

const SEO_PRESET = {
  role: 'seo',
  dashboard: { top: [], left: [], right: [], hidden: [] },
  quick_actions: [{ id: 'edit-seo' }],
  version: 2,
  updated_at: '2026-10-16T09:00:00Z',
};

beforeEach(() => {
  audits.length = 0;
});

describe('PUT /api/admin/dashboard/defaults/[role]', () => {
  it('an Admin’s first save reaches the handler: inserted for the session’s tenant, audited', async () => {
    const { run, calls } = call('admin', 'PUT', 'seo', null, {
      version: 0,
      quickActions: [{ id: 'edit-seo' }],
    });
    const response = await run();
    expect(response.status).toBe(200);
    const insert = calls.find((c) => c.op === 'insert');
    expect(insert?.args[0]).toMatchObject({
      tenant_id: TENANT,
      role: 'seo',
      quick_actions: [{ id: 'edit-seo' }],
    });
    expect(tenantsOf(calls).every((t) => t === TENANT)).toBe(true);
    expect(tenantsOf(calls).length).toBeGreaterThan(1);
    expect(audits).toEqual([
      {
        action: 'dashboard.defaults.update',
        entityType: 'admin_role_defaults',
        entityId: 'seo',
        detail: { role: 'seo', fields: ['quick_actions'] },
      },
    ]);
  });

  it('a later save updates under the version read, and names only the fields it carries', async () => {
    const { run, calls } = call('admin', 'PUT', 'seo', SEO_PRESET, {
      version: 2,
      dashboard: { top: [], left: [], right: [], hidden: [] },
    });
    expect((await run()).status).toBe(200);
    expect(calls.some((c) => c.op === 'insert')).toBe(false);
    expect(calls.filter((c) => c.op === 'eq').map((c) => c.args)).toContainEqual(['version', 2]);
    expect(audits.map((a) => a.detail)).toEqual([{ role: 'seo', fields: ['dashboard'] }]);
  });

  it('a stale version is a 409 and audits nothing', async () => {
    const { run } = call('admin', 'PUT', 'seo', SEO_PRESET, {
      version: 1,
      quickActions: [{ id: 'edit-seo' }],
    });
    expect((await run()).status).toBe(409);
    expect(audits).toEqual([]);
  });

  it('a path that is not a role is a 404, before any query', async () => {
    const { run, calls } = call('admin', 'PUT', 'owner', null, {
      version: 0,
      quickActions: [{ id: 'edit-seo' }],
    });
    expect((await run()).status).toBe(404);
    expect(calls).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('other_tenant: every read and write carries its own tenant, never this one', async () => {
    const { run, calls } = call('other_tenant', 'PUT', 'seo', null, {
      version: 0,
      quickActions: [{ id: 'edit-seo' }],
    });
    expect((await run()).status).toBe(200);
    expect(tenantsOf(calls).length).toBeGreaterThan(1);
    expect(tenantsOf(calls).every((t) => t === OTHER_TENANT)).toBe(true);
  });
});

describe('DELETE /api/admin/dashboard/defaults/[role]', () => {
  it('an Admin’s reset removes the session tenant’s row for the role, audited with the role', async () => {
    const { run, calls } = call('admin', 'DELETE', 'seo', SEO_PRESET);
    const response = await run();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { role: 'seo', removed: true } });
    expect(calls.filter((c) => c.op === 'eq').map((c) => c.args)).toEqual([
      ['tenant_id', TENANT],
      ['role', 'seo'],
    ]);
    expect(audits).toEqual([
      {
        action: 'dashboard.defaults.reset',
        entityType: 'admin_role_defaults',
        entityId: 'seo',
        detail: { role: 'seo' },
      },
    ]);
  });

  it('nothing to reset: no audit row', async () => {
    const { run } = call('admin', 'DELETE', 'seo', null);
    expect(await (await run()).json()).toMatchObject({ data: { role: 'seo', removed: false } });
    expect(audits).toEqual([]);
  });

  it('a path that is not a role is a 404', async () => {
    const { run, calls } = call('admin', 'DELETE', 'nobody', SEO_PRESET);
    expect((await run()).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('other_tenant: the delete is scoped to its own tenant', async () => {
    const { run, calls } = call('other_tenant', 'DELETE', 'seo', SEO_PRESET);
    await run();
    expect(tenantsOf(calls)).toEqual([OTHER_TENANT]);
  });
});

describe('the authz matrix’s rows for these routes reach the handler', () => {
  it('an Admin’s row is answered by the handler (2xx or 409), never the 404 of a missing [role]', async () => {
    const { cases } = await import('../authz/cases/dashboard');
    const rows = cases.filter((c) => c.url.startsWith('/api/admin/dashboard/defaults/'));
    expect(rows.map((c) => c.method).sort()).toEqual(['DELETE', 'PUT']);
    for (const row of rows) {
      const ctx = makeContext('admin', row.url, row.body, row.method, row.params);
      const status = ((await route[row.method as 'PUT' | 'DELETE'](ctx)) as Response).status;
      expect([200, 409], `${row.name} answered ${status}`).toContain(status);
    }
  });
});
