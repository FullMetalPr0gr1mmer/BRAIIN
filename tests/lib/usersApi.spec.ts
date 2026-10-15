import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIRoute } from 'astro';

// The users screen's routes (Admin v2 U12a), against the real handlers with a stubbed
// database: the owner refused in both layers' words (the Worker's 422, and the database
// guard's 42501 mapped to the same 422), the sign-out flag, the Security card's versioned
// save, "Make account owner", the invite domain, the list's join, and the §9 (b) regression:
// an Admin demoted, switched off or locked under an open session is refused (403) by every
// write here before anything is written.

interface Read {
  data: unknown;
  error: unknown;
}

const { state } = vi.hoisted(() => ({
  state: {
    /** What liveRecheck's service-role read of the caller's profile finds. */
    live: { data: null, error: null } as Read,
    stamps: [] as unknown[],
    invites: [] as unknown[],
    serviceInserts: [] as unknown[],
    audits: [] as unknown[],
    logs: [] as unknown[],
  },
}));

vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      b['select'] = () => b;
      b['eq'] = () => b;
      b['maybeSingle'] = async () =>
        table === 'profiles' ? state.live : { data: null, error: null };
      b['insert'] = async (row: unknown) => {
        state.serviceInserts.push([table, row]);
        return { error: null };
      };
      return b;
    },
    auth: {
      admin: {
        inviteUserByEmail: async (email: string) => {
          state.invites.push(email);
          return { data: { user: { id: '99999999-9999-4999-8999-999999999999' } }, error: null };
        },
        updateUserById: async (id: string, attrs: unknown) => {
          state.stamps.push({ id, attrs });
          return { data: {}, error: null };
        },
      },
    },
  }),
}));
vi.mock('@/lib/admin/audit', () => ({
  writeAudit: async (_sb: unknown, _ctx: unknown, entry: unknown) => {
    state.audits.push(entry);
    return true;
  },
}));
vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async (entry: unknown) => {
    state.logs.push(entry);
    return true;
  },
}));

const users = await import('@/pages/api/admin/users/index');
const patch = await import('@/pages/api/admin/users/[id]');
const security = await import('@/pages/api/admin/users/security');
const owner = await import('@/pages/api/admin/users/[id]/owner');
const { OWNER_PROTECTED, NOT_OWNER, BAD_TARGET } = await import('@/lib/admin/users');

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADMIN = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';

/** The Admin's session client: per table, what a read and a write answer; and the RPCs. */
interface Fake {
  reads?: Record<string, Read>;
  writes?: Record<string, Read>;
  rpc?: Record<string, Read>;
}
function session(fake: Fake) {
  const calls: unknown[][] = [];
  const client = {
    calls,
    from(table: string) {
      let mode: 'read' | 'write' = 'read';
      const answer = () =>
        (mode === 'read' ? fake.reads?.[table] : fake.writes?.[table]) ?? {
          data: null,
          error: null,
        };
      const b: Record<string, unknown> = {};
      b['select'] = () => b;
      b['eq'] = () => b;
      b['order'] = () => b;
      b['range'] = () => b;
      b['insert'] = (row: unknown) => {
        mode = 'write';
        calls.push(['insert', table, row]);
        return b;
      };
      b['update'] = (row: unknown) => {
        mode = 'write';
        calls.push(['update', table, row]);
        return b;
      };
      b['maybeSingle'] = async () => answer();
      b['single'] = async () => answer();
      b['then'] = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(resolve({ ...answer(), count: 2 }));
      return b;
    },
    async rpc(fn: string, args: unknown) {
      calls.push(['rpc', fn, args]);
      return fake.rpc?.[fn] ?? { data: null, error: null };
    },
  };
  return client;
}

function call(
  route: APIRoute,
  method: string,
  path: string,
  sb: ReturnType<typeof session>,
  body?: unknown,
  params: Record<string, string> = { id: TARGET },
) {
  const url = new URL(`https://admin.example.test${path}`);
  return route({
    request: new Request(url, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    }),
    url,
    params,
    locals: {
      session: {
        userId: ADMIN,
        tenantId: TENANT,
        role: 'admin',
        isActive: true,
        email: 'a@x.test',
      },
      supabase: sb,
      cspNonce: 'n',
      csrfToken: 'c',
    },
  } as unknown as Parameters<APIRoute>[0]) as Promise<Response>;
}

async function bodyOf(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

const liveAdmin: Read = {
  data: { role: 'admin', is_active: true, locked_until: null },
  error: null,
};

beforeEach(() => {
  state.live = liveAdmin;
  state.stamps = [];
  state.invites = [];
  state.serviceInserts = [];
  state.audits = [];
  state.logs = [];
});

describe('PATCH /api/admin/users/[id]: the account owner', () => {
  const ownerRow: Read = {
    data: { id: TARGET, role: 'admin', is_active: true, is_owner: true },
    error: null,
  };

  it.each([
    ['demoted', { role: 'seo' }],
    ['switched off', { isActive: false }],
    ['demoted and switched off', { role: 'developer', isActive: false }],
  ])('refuses the owner %s (422), before the database is asked', async (_label, body) => {
    const sb = session({ reads: { profiles: ownerRow } });
    const res = await call(
      patch.PATCH as APIRoute,
      'PATCH',
      `/api/admin/users/${TARGET}`,
      sb,
      body,
    );
    expect(res.status).toBe(422);
    expect(await bodyOf(res)).toMatchObject({ detail: OWNER_PROTECTED, field: 'owner-protected' });
    expect(sb.calls.filter((c) => c[0] === 'update')).toEqual([]);
    expect(state.stamps).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it('lets the owner be renamed, and kept an Admin', async () => {
    const sb = session({
      reads: { profiles: ownerRow },
      writes: { profiles: { data: [{ id: TARGET }], error: null } },
    });
    const res = await call(patch.PATCH as APIRoute, 'PATCH', `/api/admin/users/${TARGET}`, sb, {
      role: 'admin',
      displayName: 'Omar',
    });
    expect(res.status).toBe(200);
    expect((await bodyOf(res))['data']).toMatchObject({ signedOut: false });
  });

  it('answers the database guard (42501 owner_protected) with the same 422', async () => {
    // The marker moved between the read and the write: the database is the second layer.
    const sb = session({
      reads: { profiles: { data: { id: TARGET, role: 'admin', is_active: true }, error: null } },
      writes: { profiles: { data: null, error: { code: '42501', message: 'owner_protected' } } },
    });
    const res = await call(patch.PATCH as APIRoute, 'PATCH', `/api/admin/users/${TARGET}`, sb, {
      role: 'seo',
    });
    expect(res.status).toBe(422);
    expect(await bodyOf(res)).toMatchObject({ detail: OWNER_PROTECTED });
    expect(state.stamps).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it('any other database error stays a 500', async () => {
    const sb = session({
      reads: { profiles: { data: { id: TARGET, role: 'seo', is_active: true }, error: null } },
      writes: { profiles: { data: null, error: { code: 'XX000', message: 'boom' } } },
    });
    const res = await call(patch.PATCH as APIRoute, 'PATCH', `/api/admin/users/${TARGET}`, sb, {
      role: 'developer',
    });
    expect(res.status).toBe(500);
  });
});

describe('PATCH /api/admin/users/[id]: says when the person was signed out', () => {
  const colleague: Read = {
    data: { id: TARGET, role: 'seo', is_active: true, is_owner: false },
    error: null,
  };
  const written: Read = { data: [{ id: TARGET }], error: null };

  it.each([
    [{ role: 'developer' }, true],
    [{ isActive: false }, true],
    [{ role: 'seo' }, false],
    [{ isActive: true }, false],
    [{ displayName: 'Sam' }, false],
  ])('%j → signedOut %s', async (body, signedOut) => {
    const sb = session({ reads: { profiles: colleague }, writes: { profiles: written } });
    const res = await call(
      patch.PATCH as APIRoute,
      'PATCH',
      `/api/admin/users/${TARGET}`,
      sb,
      body,
    );
    expect(res.status).toBe(200);
    expect((await bodyOf(res))['data']).toMatchObject({ signedOut });
  });
});

describe('GET and PUT /api/admin/users/security', () => {
  const stored: Read = {
    data: { session_max_days: 1, invite_domain: 'example.com', version: 3 },
    error: null,
  };

  it('answers the defaults at version 0 while no row exists', async () => {
    const sb = session({});
    const res = await call(security.GET as APIRoute, 'GET', '/api/admin/users/security', sb);
    expect((await bodyOf(res))['data']).toEqual({
      sessionMaxDays: 7,
      inviteDomain: null,
      version: 0,
    });
  });

  it('answers the stored row', async () => {
    const sb = session({ reads: { admin_security_settings: stored } });
    const res = await call(security.GET as APIRoute, 'GET', '/api/admin/users/security', sb);
    expect((await bodyOf(res))['data']).toEqual({
      sessionMaxDays: 1,
      inviteDomain: 'example.com',
      version: 3,
    });
  });

  it('creates the row on the first save (version 0), lower-casing the domain, audited by field name', async () => {
    const sb = session({
      writes: {
        admin_security_settings: {
          data: { session_max_days: 1, invite_domain: 'example.com', version: 1 },
          error: null,
        },
      },
    });
    const res = await call(security.PUT as APIRoute, 'PUT', '/api/admin/users/security', sb, {
      sessionMaxDays: 1,
      inviteDomain: ' @Example.COM ',
      version: 0,
    });
    expect(res.status).toBe(200);
    expect(sb.calls).toContainEqual([
      'insert',
      'admin_security_settings',
      { tenant_id: TENANT, session_max_days: 1, invite_domain: 'example.com' },
    ]);
    expect(state.audits).toEqual([
      {
        action: 'user.security_update',
        entityType: 'security_settings',
        entityId: TENANT,
        detail: { fields: ['session_max_days', 'invite_domain'] },
      },
    ]);
    expect((await bodyOf(res))['data']).toEqual({
      sessionMaxDays: 1,
      inviteDomain: 'example.com',
      version: 1,
    });
  });

  it('a first save carrying another version, or racing another Admin, is a 409', async () => {
    let sb = session({});
    let res = await call(security.PUT as APIRoute, 'PUT', '/api/admin/users/security', sb, {
      sessionMaxDays: 1,
      inviteDomain: null,
      version: 4,
    });
    expect(res.status).toBe(409);
    expect(sb.calls).toEqual([]);
    sb = session({
      writes: { admin_security_settings: { data: null, error: { code: '23505', message: 'dup' } } },
    });
    res = await call(security.PUT as APIRoute, 'PUT', '/api/admin/users/security', sb, {
      sessionMaxDays: 1,
      inviteDomain: null,
      version: 0,
    });
    expect(res.status).toBe(409);
    expect(state.audits).toEqual([]);
  });

  it('changes the row at the version read, and only what changed is named', async () => {
    const sb = session({
      reads: { admin_security_settings: stored },
      writes: {
        admin_security_settings: {
          data: { session_max_days: 7, invite_domain: 'example.com', version: 4 },
          error: null,
        },
      },
    });
    const res = await call(security.PUT as APIRoute, 'PUT', '/api/admin/users/security', sb, {
      sessionMaxDays: 7,
      inviteDomain: 'example.com',
      version: 3,
    });
    expect(res.status).toBe(200);
    expect(sb.calls).toContainEqual([
      'update',
      'admin_security_settings',
      { session_max_days: 7, invite_domain: 'example.com' },
    ]);
    expect(state.audits).toEqual([
      expect.objectContaining({ detail: { fields: ['session_max_days'] } }),
    ]);
  });

  it('a stale version, or a write that matched no row, is a 409', async () => {
    let sb = session({ reads: { admin_security_settings: stored } });
    let res = await call(security.PUT as APIRoute, 'PUT', '/api/admin/users/security', sb, {
      sessionMaxDays: 7,
      inviteDomain: null,
      version: 2,
    });
    expect(res.status).toBe(409);
    sb = session({ reads: { admin_security_settings: stored } });
    res = await call(security.PUT as APIRoute, 'PUT', '/api/admin/users/security', sb, {
      sessionMaxDays: 7,
      inviteDomain: null,
      version: 3,
    });
    expect(res.status).toBe(409);
    expect(state.audits).toEqual([]);
  });

  it('a save that changes nothing writes and audits nothing', async () => {
    const sb = session({ reads: { admin_security_settings: stored } });
    const res = await call(security.PUT as APIRoute, 'PUT', '/api/admin/users/security', sb, {
      sessionMaxDays: 1,
      inviteDomain: 'EXAMPLE.com',
      version: 3,
    });
    expect(res.status).toBe(200);
    expect(sb.calls).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it.each([
    [{ sessionMaxDays: 30, inviteDomain: null, version: 0 }],
    [{ sessionMaxDays: 7, inviteDomain: 'https://example.com', version: 0 }],
    [{ sessionMaxDays: 7, inviteDomain: 'team@example.com', version: 0 }],
    [{ sessionMaxDays: 7, inviteDomain: 'localhost', version: 0 }],
    [{ sessionMaxDays: 7, inviteDomain: null, version: 0, extra: 1 }],
  ])('refuses %j (422)', async (body) => {
    const sb = session({});
    const res = await call(security.PUT as APIRoute, 'PUT', '/api/admin/users/security', sb, body);
    expect(res.status).toBe(422);
    expect(sb.calls).toEqual([]);
  });

  it('the database refusing the session (42501) is a 403', async () => {
    const sb = session({
      reads: { admin_security_settings: stored },
      writes: { admin_security_settings: { data: null, error: { code: '42501', message: 'rls' } } },
    });
    const res = await call(security.PUT as APIRoute, 'PUT', '/api/admin/users/security', sb, {
      sessionMaxDays: 7,
      inviteDomain: null,
      version: 3,
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/admin/users/[id]/owner', () => {
  const asOwner: Read = { data: { is_owner: true }, error: null };

  it('an Admin who is not the owner is answered 422, and the database is not asked', async () => {
    const sb = session({ reads: { profiles: { data: { is_owner: false }, error: null } } });
    const res = await call(owner.POST as APIRoute, 'POST', `/api/admin/users/${TARGET}/owner`, sb);
    expect(res.status).toBe(422);
    expect(await bodyOf(res)).toMatchObject({ detail: NOT_OWNER });
    expect(sb.calls).toEqual([]);
  });

  it('the owner cannot name themselves', async () => {
    const sb = session({ reads: { profiles: asOwner } });
    const res = await call(
      owner.POST as APIRoute,
      'POST',
      `/api/admin/users/${ADMIN}/owner`,
      sb,
      undefined,
      {
        id: ADMIN,
      },
    );
    expect(res.status).toBe(422);
    expect(await bodyOf(res)).toMatchObject({ detail: BAD_TARGET });
  });

  it('the owner hands it on through transfer_ownership, which audits it', async () => {
    const sb = session({ reads: { profiles: asOwner } });
    const res = await call(owner.POST as APIRoute, 'POST', `/api/admin/users/${TARGET}/owner`, sb);
    expect(res.status).toBe(200);
    expect(sb.calls).toEqual([['rpc', 'transfer_ownership', { p_tenant: TENANT, p_to: TARGET }]]);
    expect((await bodyOf(res))['data']).toEqual({ owner: TARGET });
    // The RPC writes the audit row in its own transaction; the route adds none.
    expect(state.audits).toEqual([]);
  });

  it.each([
    ['22023', 422],
    ['42501', 403],
    ['XX000', 500],
  ])('the database answering %s is a %i', async (code, status) => {
    const sb = session({
      reads: { profiles: asOwner },
      rpc: { transfer_ownership: { data: null, error: { code, message: 'refused' } } },
    });
    const res = await call(owner.POST as APIRoute, 'POST', `/api/admin/users/${TARGET}/owner`, sb);
    expect(res.status).toBe(status);
  });

  it('a path that is not an id is a 404', async () => {
    const sb = session({ reads: { profiles: asOwner } });
    const res = await call(
      owner.POST as APIRoute,
      'POST',
      '/api/admin/users/x/owner',
      sb,
      undefined,
      {
        id: 'not-a-uuid',
      },
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /api/admin/users: the allowed invite domain', () => {
  const withDomain: Read = {
    data: { session_max_days: 7, invite_domain: 'example.com', version: 1 },
    error: null,
  };

  it.each(['someone@other.test', 'someone@team.example.com', 'someone@example.com.evil.test'])(
    'refuses %s while the domain is example.com (422 on the e-mail field)',
    async (email) => {
      const sb = session({ reads: { admin_security_settings: withDomain } });
      const res = await call(users.POST as APIRoute, 'POST', '/api/admin/users', sb, {
        email,
        role: 'seo',
      });
      expect(res.status).toBe(422);
      expect(await bodyOf(res)).toMatchObject({
        field: 'email',
        detail: 'Only example.com addresses can be invited. Change it in Security.',
      });
      expect(state.invites).toEqual([]);
    },
  );

  it('invites an address at the domain, whatever its case', async () => {
    const sb = session({ reads: { admin_security_settings: withDomain } });
    const res = await call(users.POST as APIRoute, 'POST', '/api/admin/users', sb, {
      email: 'Someone@EXAMPLE.com',
      role: 'seo',
    });
    expect(res.status).toBe(200);
    expect(state.invites).toEqual(['someone@example.com']);
  });

  it('invites anyone while no domain is set', async () => {
    const sb = session({});
    const res = await call(users.POST as APIRoute, 'POST', '/api/admin/users', sb, {
      email: 'someone@other.test',
      role: 'seo',
    });
    expect(res.status).toBe(200);
  });
});

describe('GET /api/admin/users: profiles joined to their accounts', () => {
  const profiles: Read = {
    data: [
      {
        id: ADMIN,
        role: 'admin',
        is_active: true,
        display_name: 'Amal',
        locked_until: null,
        created_at: 'x',
        is_owner: true,
      },
      {
        id: TARGET,
        role: 'seo',
        is_active: true,
        display_name: null,
        locked_until: null,
        created_at: 'y',
        is_owner: false,
      },
    ],
    error: null,
  };

  it('joins each profile to its e-mail and sign-in times, with the owner and the status', async () => {
    const sb = session({
      reads: { profiles },
      rpc: {
        staff_accounts: {
          data: [
            {
              id: ADMIN,
              email: 'amal@x.test',
              invited_at: null,
              email_confirmed_at: '2026-01-01T00:00:00Z',
              last_sign_in_at: '2026-10-01T00:00:00Z',
              is_owner: true,
            },
            {
              id: TARGET,
              email: 'new@x.test',
              invited_at: '2026-10-14T00:00:00Z',
              email_confirmed_at: null,
              last_sign_in_at: null,
              is_owner: false,
            },
          ],
          error: null,
        },
      },
    });
    const res = await call(users.GET as APIRoute, 'GET', '/api/admin/users', sb);
    const data = (await bodyOf(res))['data'] as Record<string, unknown>;
    expect(data['hasOwner']).toBe(true);
    expect(data['rows']).toEqual([
      expect.objectContaining({
        id: ADMIN,
        email: 'amal@x.test',
        isOwner: true,
        status: 'active',
        confirmed: true,
      }),
      expect.objectContaining({
        id: TARGET,
        email: 'new@x.test',
        isOwner: false,
        status: 'invited',
        confirmed: false,
      }),
    ]);
    expect(sb.calls).toContainEqual(['rpc', 'staff_accounts', { p_tenant: TENANT }]);
  });

  it('lists the people without e-mails when the directory cannot be read', async () => {
    const sb = session({
      reads: { profiles },
      rpc: { staff_accounts: { data: null, error: { message: 'function does not exist' } } },
    });
    const res = await call(users.GET as APIRoute, 'GET', '/api/admin/users', sb);
    const data = (await bodyOf(res))['data'] as { rows: { email: unknown }[]; hasOwner: boolean };
    expect(res.status).toBe(200);
    expect(data.rows.map((r) => r.email)).toEqual([null, null]);
    expect(data.hasOwner).toBe(false);
  });
});

describe('§9 (b): an Admin demoted, switched off or locked under an open session writes nothing', () => {
  const stale: [string, Read][] = [
    ['demoted', { data: { role: 'seo', is_active: true, locked_until: null }, error: null }],
    [
      'switched off',
      { data: { role: 'admin', is_active: false, locked_until: null }, error: null },
    ],
    [
      'locked',
      {
        data: {
          role: 'admin',
          is_active: true,
          locked_until: new Date(Date.now() + 600_000).toISOString(),
        },
        error: null,
      },
    ],
  ];

  it.each(stale)(
    '%s: PUT security, POST owner, PATCH user and POST invite are 403',
    async (_label, live) => {
      state.live = live;
      const sb = session({
        reads: {
          profiles: {
            data: { id: TARGET, role: 'seo', is_active: true, is_owner: true },
            error: null,
          },
        },
      });
      const answers = [
        await call(security.PUT as APIRoute, 'PUT', '/api/admin/users/security', sb, {
          sessionMaxDays: 1,
          inviteDomain: null,
          version: 0,
        }),
        await call(owner.POST as APIRoute, 'POST', `/api/admin/users/${TARGET}/owner`, sb),
        await call(patch.PATCH as APIRoute, 'PATCH', `/api/admin/users/${TARGET}`, sb, {
          role: 'admin',
        }),
        await call(users.POST as APIRoute, 'POST', '/api/admin/users', sb, {
          email: 'x@example.test',
          role: 'admin',
        }),
      ];
      expect(answers.map((r) => r.status)).toEqual([403, 403, 403, 403]);
      expect(sb.calls.filter((c) => c[0] !== 'select')).toEqual([]);
      expect(state.invites).toEqual([]);
      expect(state.stamps).toEqual([]);
      expect(state.audits).toEqual([]);
    },
  );
});
