import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIRoute } from 'astro';

// PATCH /api/admin/users/[id] writes the profile through the Admin's own session, so RLS
// decides, and since 0050 (hotfix H10) that includes a live check: the token's role must
// still be the profile's, active, unlocked, in this tenant. RLS skips a row it will not let
// a session write instead of raising, so a refused write would otherwise look like a
// successful one: the route would then stamp the new role into the person's claims with the
// service role and audit a change that never happened. Pinned here, against the real route.

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADMIN = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';

const stamps: unknown[] = [];
const audits: unknown[] = [];
const logs: unknown[] = [];
const existenceReads: unknown[][] = [];
let updatedRows: unknown[] = [];
// What the service role's existence read finds after a write came back empty.
let stillThere: { data: unknown; error: unknown } = { data: { id: TARGET }, error: null };

vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      b['select'] = () => b;
      b['eq'] = (...args: unknown[]) => {
        existenceReads.push([table, ...args]);
        return b;
      };
      b['maybeSingle'] = async () => stillThere;
      return b;
    },
    auth: {
      admin: {
        updateUserById: async (id: string, attrs: unknown) => {
          stamps.push({ id, attrs });
          return { data: {}, error: null };
        },
      },
    },
  }),
}));
vi.mock('@/lib/admin/liveRecheck', () => ({ liveRecheck: async () => undefined }));
vi.mock('@/lib/admin/audit', () => ({
  writeAudit: async (_sb: unknown, _ctx: unknown, entry: unknown) => {
    audits.push(entry);
    return true;
  },
}));
vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async (entry: unknown) => {
    logs.push(entry);
    return true;
  },
}));

const { PATCH } = await import('@/pages/api/admin/users/[id]');

/** The Admin's session client: the read finds the target; the update returns `updatedRows`. */
function session() {
  const read: Record<string, unknown> = {};
  read['select'] = () => read;
  read['eq'] = () => read;
  read['maybeSingle'] = async () => ({
    data: { id: TARGET, role: 'content_creator', is_active: true },
    error: null,
  });
  const write: Record<string, unknown> = {};
  write['eq'] = () => write;
  write['select'] = async () => ({ data: updatedRows, error: null });
  return {
    from: () => ({ ...read, update: () => write }),
  };
}

function call(body: unknown) {
  const url = new URL(`https://admin.example.test/api/admin/users/${TARGET}`);
  return (PATCH as APIRoute)({
    request: new Request(url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    url,
    params: { id: TARGET },
    locals: {
      session: {
        userId: ADMIN,
        tenantId: TENANT,
        role: 'admin',
        isActive: true,
        email: 'a@x.test',
      },
      supabase: session(),
      cspNonce: 'n',
      csrfToken: 'c',
    },
  } as unknown as Parameters<APIRoute>[0]) as Promise<Response>;
}

beforeEach(() => {
  stamps.length = 0;
  audits.length = 0;
  logs.length = 0;
  existenceReads.length = 0;
  updatedRows = [];
  stillThere = { data: { id: TARGET }, error: null };
});

describe('PATCH /api/admin/users/[id] when the database refuses the session (0050)', () => {
  it('is a 403 that stamps no claims, audits nothing and logs the refusal by target id only', async () => {
    const res = await call({ role: 'seo' });
    expect(res.status).toBe(403);
    expect(stamps).toEqual([]);
    expect(audits).toEqual([]);
    expect(logs).toEqual([
      {
        level: 'warn',
        source: 'admin:users.manage',
        message: 'profile write refused by the database for this session',
        detail: { target: TARGET },
      },
    ]);
    // The existence check is the service role's, fenced to the caller's tenant.
    expect(existenceReads).toContainEqual(['profiles', 'tenant_id', TENANT]);
    expect(existenceReads).toContainEqual(['profiles', 'id', TARGET]);
  });

  it('is a 404 when the profile went between the read and the write: nothing stamped, audited or logged', async () => {
    stillThere = { data: null, error: null };
    const res = await call({ role: 'seo' });
    expect(res.status).toBe(404);
    expect(stamps).toEqual([]);
    expect(audits).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('stays a 403 when the existence read itself fails (never a 404 it cannot vouch for)', async () => {
    stillThere = { data: null, error: { message: 'unavailable' } };
    const res = await call({ isActive: false });
    expect(res.status).toBe(403);
    expect(audits).toEqual([]);
    expect(logs).toHaveLength(1);
  });

  it('a deactivation the database refused is not audited either', async () => {
    const res = await call({ isActive: false });
    expect(res.status).toBe(403);
    expect(audits).toEqual([]);
  });

  it('a live Admin is unchanged: the row comes back, the claims are stamped, the change audited', async () => {
    updatedRows = [{ id: TARGET }];
    const res = await call({ role: 'seo' });
    expect(res.status).toBe(200);
    expect(stamps).toEqual([
      { id: TARGET, attrs: { app_metadata: { role: 'seo', tenant_id: TENANT } } },
    ]);
    expect(audits).toEqual([
      expect.objectContaining({ action: 'user.update', entityType: 'profile', entityId: TARGET }),
    ]);
    expect(logs).toEqual([]);
    expect(existenceReads).toEqual([]);
  });
});
