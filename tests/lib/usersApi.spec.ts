import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIRoute } from 'astro';
import { PUBLIC_SITE_URL } from '../stubs/astro-env-client';

// The users screen's routes (Admin v2 U12a), against the real handlers with a stubbed
// database: the owner refused in both layers' words (the Worker's 422, and the database
// guard's 42501 mapped to the same 422), the sign-out flag, the Security card's versioned
// save, "Make account owner", the invite domain, the list's join, and the §9 (b) regression:
// an Admin demoted, switched off or locked under an open session is refused (403) by every
// write here before anything is written. And U12b's invites: switched off while e-mail is not
// set up (503, nothing counted or sent), the message, the limit, no address in the audit
// (D5), Resend and Cancel with their refusals (D7), and the pending list.

interface Read {
  data: unknown;
  error: unknown;
}

const { state } = vi.hoisted(() => ({
  state: {
    /** What liveRecheck's service-role read of the caller's profile finds. */
    live: { data: null, error: null } as Read,
    /** What the invite's service-role check finds for the invited account's profile. */
    invitedProfile: { data: null, error: null } as Read,
    stamps: [] as unknown[],
    invites: [] as unknown[],
    /** The options each invite call carried (redirectTo, data). */
    inviteOptions: [] as unknown[],
    serviceInserts: [] as unknown[],
    /** AUTH_EMAIL_READY, through authEmailReady() (src/lib/auth/recovery.ts). */
    emailReady: true,
    /** Each privileged_ops claim, and whether the next one is refused. */
    claims: [] as unknown[],
    limitFull: false,
    /** What GoTrue's admin API knows of an account (Resend and Cancel read it). */
    account: null as Record<string, unknown> | null,
    deleted: [] as string[],
    inviteError: null as null | { message: string; status?: number },
    profileInsertError: null as null | { code: string; message: string },
    audits: [] as unknown[],
    logs: [] as unknown[],
  },
}));

vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      let columns = '';
      b['select'] = (cols: string) => {
        columns = cols;
        return b;
      };
      b['eq'] = () => b;
      // liveRecheck reads the caller's role, is_active and locked_until; the invite asks
      // only whether the invited account already has a profile (its id).
      b['maybeSingle'] = async () =>
        table !== 'profiles'
          ? { data: null, error: null }
          : columns === 'id'
            ? state.invitedProfile
            : state.live;
      b['insert'] = async (row: unknown) => {
        state.serviceInserts.push([table, row]);
        return { error: table === 'profiles' ? state.profileInsertError : null };
      };
      return b;
    },
    auth: {
      admin: {
        inviteUserByEmail: async (email: string, options?: unknown) => {
          if (state.inviteError) return { data: { user: null }, error: state.inviteError };
          state.invites.push(email);
          state.inviteOptions.push(options);
          return { data: { user: { id: '99999999-9999-4999-8999-999999999999' } }, error: null };
        },
        getUserById: async () =>
          state.account
            ? { data: { user: state.account }, error: null }
            : { data: { user: null }, error: { message: 'User not found', status: 404 } },
        deleteUser: async (id: string) => {
          state.deleted.push(id);
          return { data: {}, error: null };
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
vi.mock('@/lib/auth/recovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/recovery')>()),
  authEmailReady: () => state.emailReady,
}));
vi.mock('@/lib/admin/rateLimit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin/rateLimit')>();
  const { RateLimitError } = await import('@/lib/admin/errors');
  return {
    ...actual,
    claimPrivilegedOp: async (_auth: unknown, op: string, limits: unknown) => {
      state.claims.push([op, limits]);
      if (state.limitFull) throw new RateLimitError(`${op}:user`);
    },
  };
});

const users = await import('@/pages/api/admin/users/index');
const patch = await import('@/pages/api/admin/users/[id]');
const security = await import('@/pages/api/admin/users/security');
const owner = await import('@/pages/api/admin/users/[id]/owner');
const resend = await import('@/pages/api/admin/users/[id]/resend');
const cancel = await import('@/pages/api/admin/users/[id]/invite');
const twoStepReset = await import('@/pages/api/admin/users/[id]/two-step-reset');
const {
  OWNER_PROTECTED,
  NOT_OWNER,
  BAD_TARGET,
  INVITE_ALREADY_JOINED,
  INVITE_EXISTS,
  INVITE_LIMITS,
  INVITE_SWITCHED_OFF,
} = await import('@/lib/admin/users');

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
      b['in'] = (column: string, values: unknown) => {
        calls.push(['in', table, column, values]);
        return b;
      };
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
      // The directory answers (empty) unless a test says otherwise.
      return (
        fake.rpc?.[fn] ??
        (fn === 'staff_accounts' ? { data: [], error: null } : { data: null, error: null })
      );
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
  /** More of the caller's context (U17: their own 2FA). */
  extra: Record<string, unknown> = {},
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
        ...extra,
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
  state.invitedProfile = { data: null, error: null };
  state.stamps = [];
  state.invites = [];
  state.inviteOptions = [];
  state.serviceInserts = [];
  state.emailReady = true;
  state.claims = [];
  state.limitFull = false;
  state.account = {
    id: TARGET,
    email: 'new@x.test',
    invited_at: '2026-10-14T00:00:00Z',
    email_confirmed_at: null,
    last_sign_in_at: null,
  };
  state.deleted = [];
  state.inviteError = null;
  state.profileInsertError = null;
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
      requireMfa: false,
      version: 0,
    });
  });

  it('answers the stored row', async () => {
    const sb = session({ reads: { admin_security_settings: stored } });
    const res = await call(security.GET as APIRoute, 'GET', '/api/admin/users/security', sb);
    expect((await bodyOf(res))['data']).toEqual({
      sessionMaxDays: 1,
      inviteDomain: 'example.com',
      requireMfa: false,
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
      { tenant_id: TENANT, session_max_days: 1, invite_domain: 'example.com', require_mfa: false },
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
      requireMfa: false,
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
      { session_max_days: 7, invite_domain: 'example.com', require_mfa: false },
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
    const data = (await bodyOf(res))['data'] as {
      rows: { email: unknown }[];
      hasOwner: boolean | null;
    };
    expect(res.status).toBe(200);
    expect(data.rows.map((r) => r.email)).toEqual([null, null]);
    // Not "no owner": this page lists one (its own rows say so), and with none listed the
    // answer is unknown, never false (the screen would announce a missing owner).
    expect(data.hasOwner).toBe(true);
  });

  it('says nothing about the owner when the directory fails and no listed row is it', async () => {
    const noOwner: Read = {
      data: (profiles.data as Record<string, unknown>[]).map((p) => ({ ...p, is_owner: false })),
      error: null,
    };
    const sb = session({
      reads: { profiles: noOwner },
      rpc: { staff_accounts: { data: null, error: { message: 'down' } } },
    });
    const res = await call(users.GET as APIRoute, 'GET', '/api/admin/users', sb);
    expect(((await bodyOf(res))['data'] as { hasOwner: unknown }).hasOwner).toBeNull();
  });

  it('says no owner only when the directory was read and names none', async () => {
    const sb = session({
      reads: { profiles },
      rpc: { staff_accounts: { data: [], error: null } },
    });
    const res = await call(users.GET as APIRoute, 'GET', '/api/admin/users', sb);
    expect(((await bodyOf(res))['data'] as { hasOwner: unknown }).hasOwner).toBe(false);
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
    '%s: PUT security, POST owner, PATCH user, POST invite, resend, cancel and Reset 2FA are 403',
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
        await call(resend.POST as APIRoute, 'POST', `/api/admin/users/${TARGET}/resend`, sb),
        await call(cancel.DELETE as APIRoute, 'DELETE', `/api/admin/users/${TARGET}/invite`, sb),
        // U17: refused before public.reset_two_step is asked (it checks the same again).
        await call(
          twoStepReset.POST as APIRoute,
          'POST',
          `/api/admin/users/${TARGET}/two-step-reset`,
          sb,
        ),
      ];
      expect(answers.map((r) => r.status)).toEqual([403, 403, 403, 403, 403, 403, 403]);
      expect(sb.calls.filter((c) => c[0] === 'rpc' && c[1] === 'reset_two_step')).toEqual([]);
      expect(state.deleted).toEqual([]);
      expect(state.claims).toEqual([]);
      expect(sb.calls.filter((c) => c[0] !== 'select')).toEqual([]);
      expect(state.invites).toEqual([]);
      expect(state.stamps).toEqual([]);
      expect(state.audits).toEqual([]);
    },
  );
});

// ── Invites (Admin v2 U12b) ───────────────────────────────────────────────────────────────

const pendingProfile: Read = {
  data: { id: TARGET, role: 'seo', is_active: true, is_owner: false },
  error: null,
};

describe('POST /api/admin/users: invites while e-mail is not set up (O-2, O-22)', () => {
  it('answers 503 not-set-up, and reads, counts, sends and audits nothing', async () => {
    state.emailReady = false;
    const sb = session({});
    const res = await call(users.POST as APIRoute, 'POST', '/api/admin/users', sb, {
      email: 'someone@example.test',
      role: 'seo',
    });
    expect(res.status).toBe(503);
    expect(await bodyOf(res)).toEqual({ ok: false, error: 'not-set-up' });
    expect(sb.calls).toEqual([]);
    expect(state.claims).toEqual([]);
    expect(state.invites).toEqual([]);
    expect(state.serviceInserts).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it('Resend says the same; Cancel still works, since it sends nothing', async () => {
    state.emailReady = false;
    const sb = session({ reads: { profiles: pendingProfile } });
    const off = await call(
      resend.POST as APIRoute,
      'POST',
      `/api/admin/users/${TARGET}/resend`,
      sb,
    );
    expect(off.status).toBe(503);
    expect(state.invites).toEqual([]);
    const done = await call(
      cancel.DELETE as APIRoute,
      'DELETE',
      `/api/admin/users/${TARGET}/invite`,
      sb,
    );
    expect(done.status).toBe(200);
    expect(state.deleted).toEqual([TARGET]);
  });
});

describe('POST /api/admin/users: the invite, switched on', () => {
  it('sends the link to /admin/invite with the message, counted, audited without the address', async () => {
    const sb = session({});
    const res = await call(users.POST as APIRoute, 'POST', '/api/admin/users', sb, {
      email: 'Someone@Example.test',
      role: 'seo',
      message: '  Welcome to the team!\nSee you Monday.  ',
    });
    expect(res.status).toBe(200);
    expect(state.claims).toEqual([['user-invite', INVITE_LIMITS]]);
    expect(state.invites).toEqual(['someone@example.test']);
    expect(state.inviteOptions).toEqual([
      {
        redirectTo: `${PUBLIC_SITE_URL}/admin/invite`,
        data: { invite_message: 'Welcome to the team! See you Monday.' },
      },
    ]);
    expect(state.audits).toEqual([
      expect.objectContaining({
        action: 'user.invite',
        detail: { role: 'seo', withMessage: true },
      }),
    ]);
    expect(JSON.stringify(state.audits)).not.toContain('someone@example.test');
    expect(JSON.stringify(state.audits)).not.toContain('Welcome');
  });

  it('no message: an empty one is none, and no metadata is set', async () => {
    const sb = session({});
    await call(users.POST as APIRoute, 'POST', '/api/admin/users', sb, {
      email: 'a@example.test',
      role: 'seo',
      message: '   ',
    });
    expect(state.inviteOptions).toEqual([
      { redirectTo: `${PUBLIC_SITE_URL}/admin/invite`, data: {} },
    ]);
    expect(state.audits).toEqual([
      expect.objectContaining({ detail: { role: 'seo', withMessage: false } }),
    ]);
  });

  it.each([
    ['markup', 'Hi <b>there</b>'],
    ['a control character', 'Hi\u0007there'],
    ['a format character', 'Hi\u202Ethere'],
    ['301 characters', 'x'.repeat(301)],
  ])('refuses a message with %s (422), before anything is sent', async (_label, message) => {
    const sb = session({});
    const res = await call(users.POST as APIRoute, 'POST', '/api/admin/users', sb, {
      email: 'a@example.test',
      role: 'seo',
      message,
    });
    expect(res.status).toBe(422);
    expect(state.invites).toEqual([]);
    expect(state.claims).toEqual([]);
  });

  it('an address that already has an account here is refused, before anything is counted', async () => {
    const sb = session({
      rpc: {
        staff_accounts: {
          data: [
            {
              id: TARGET,
              email: 'taken@example.test',
              invited_at: null,
              email_confirmed_at: 'x',
              last_sign_in_at: 'y',
              is_owner: false,
            },
          ],
          error: null,
        },
      },
    });
    const res = await call(users.POST as APIRoute, 'POST', '/api/admin/users', sb, {
      email: 'Taken@example.test',
      role: 'admin',
    });
    expect(res.status).toBe(422);
    expect(await bodyOf(res)).toMatchObject({ field: 'email', detail: INVITE_EXISTS });
    expect(state.claims).toEqual([]);
    expect(state.invites).toEqual([]);
  });

  it('a profile that already exists (23505) is the same refusal, not a 500', async () => {
    state.profileInsertError = { code: '23505', message: 'duplicate key' };
    const sb = session({});
    const res = await call(users.POST as APIRoute, 'POST', '/api/admin/users', sb, {
      email: 'a@example.test',
      role: 'seo',
    });
    expect(res.status).toBe(422);
    expect(await bodyOf(res)).toMatchObject({ detail: INVITE_EXISTS });
    expect(state.audits).toEqual([]);
  });

  it('an existing account the directory did not show is refused before anything is stamped on it', async () => {
    // GoTrue answers an address it knows with that account (another tenant's, or past the
    // directory's 200): its role, tenant and profile are left as they were.
    state.invitedProfile = { data: { id: '99999999-9999-4999-8999-999999999999' }, error: null };
    const sb = session({});
    const res = await call(users.POST as APIRoute, 'POST', '/api/admin/users', sb, {
      email: 'elsewhere@example.test',
      role: 'admin',
    });
    expect(res.status).toBe(422);
    expect(await bodyOf(res)).toMatchObject({ field: 'email', detail: INVITE_EXISTS });
    expect(state.stamps).toEqual([]);
    expect(state.serviceInserts).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it('an unreadable profile check stamps nothing', async () => {
    state.invitedProfile = { data: null, error: { message: 'down' } };
    const sb = session({});
    const res = await call(users.POST as APIRoute, 'POST', '/api/admin/users', sb, {
      email: 'a@example.test',
      role: 'seo',
    });
    expect(res.status).toBe(500);
    expect(state.stamps).toEqual([]);
    expect(state.serviceInserts).toEqual([]);
  });

  it('an unreadable directory refuses the invite (fails closed): nothing counted or sent', async () => {
    for (const answer of [
      { data: null, error: { message: 'down' } },
      { data: null, error: null },
    ]) {
      state.claims = [];
      const sb = session({ rpc: { staff_accounts: answer } });
      const res = await call(users.POST as APIRoute, 'POST', '/api/admin/users', sb, {
        email: 'a@example.test',
        role: 'seo',
      });
      expect(res.status).toBe(500);
      expect(state.claims).toEqual([]);
      expect(state.invites).toEqual([]);
      expect(state.stamps).toEqual([]);
    }
  });

  it('past the limit: 429, and nothing is sent', async () => {
    state.limitFull = true;
    const sb = session({});
    const res = await call(users.POST as APIRoute, 'POST', '/api/admin/users', sb, {
      email: 'a@example.test',
      role: 'seo',
    });
    expect(res.status).toBe(429);
    expect(state.invites).toEqual([]);
    expect(state.audits).toEqual([]);
  });
});

describe('POST /api/admin/users/[id]/resend', () => {
  const path = `/api/admin/users/${TARGET}/resend`;

  it('sends a pending invite again, to /admin/invite, counted against the same limit, audited by role', async () => {
    const sb = session({ reads: { profiles: pendingProfile } });
    const res = await call(resend.POST as APIRoute, 'POST', path, sb);
    expect(res.status).toBe(200);
    expect((await bodyOf(res))['data']).toEqual({ id: TARGET, resent: true });
    expect(state.claims).toEqual([['user-invite', INVITE_LIMITS]]);
    expect(state.invites).toEqual(['new@x.test']);
    expect(state.inviteOptions).toEqual([{ redirectTo: `${PUBLIC_SITE_URL}/admin/invite` }]);
    expect(state.audits).toEqual([
      {
        action: 'user.invite_resend',
        entityType: 'profile',
        entityId: TARGET,
        detail: { role: 'seo' },
      },
    ]);
  });

  it.each([
    ['confirmed', { email_confirmed_at: '2026-10-15T00:00:00Z' }],
    ['signed in', { last_sign_in_at: '2026-10-15T00:00:00Z' }],
    ['never invited (created by an operator)', { invited_at: null }],
  ])('refuses an account that has %s (422), sending nothing', async (_label, change) => {
    state.account = { ...state.account!, ...change };
    const sb = session({ reads: { profiles: pendingProfile } });
    const res = await call(resend.POST as APIRoute, 'POST', path, sb);
    expect(res.status).toBe(422);
    expect(await bodyOf(res)).toMatchObject({ detail: INVITE_ALREADY_JOINED });
    expect(state.invites).toEqual([]);
    expect(state.claims).toEqual([]);
  });

  it('refuses a switched-off account, the owner, yourself, and an address outside the domain', async () => {
    const off = session({
      reads: {
        profiles: { data: { ...(pendingProfile.data as object), is_active: false }, error: null },
      },
    });
    expect(await bodyOf(await call(resend.POST as APIRoute, 'POST', path, off))).toMatchObject({
      detail: INVITE_SWITCHED_OFF,
    });
    const theOwner = session({
      reads: {
        profiles: { data: { ...(pendingProfile.data as object), is_owner: true }, error: null },
      },
    });
    expect((await call(resend.POST as APIRoute, 'POST', path, theOwner)).status).toBe(422);
    const self = await call(
      resend.POST as APIRoute,
      'POST',
      `/api/admin/users/${ADMIN}/resend`,
      session({ reads: { profiles: pendingProfile } }),
      undefined,
      { id: ADMIN },
    );
    expect(self.status).toBe(422);
    const domain = session({
      reads: {
        profiles: pendingProfile,
        admin_security_settings: {
          data: { session_max_days: 7, invite_domain: 'example.com', version: 1 },
          error: null,
        },
      },
    });
    const outside = await call(resend.POST as APIRoute, 'POST', path, domain);
    expect(outside.status).toBe(422);
    expect(await bodyOf(outside)).toMatchObject({
      detail: 'Only example.com addresses can be invited. Change it in Security.',
    });
    expect(state.invites).toEqual([]);
  });

  it("another tenant's account, or a path that is not an id, is a 404", async () => {
    const none = await call(resend.POST as APIRoute, 'POST', path, session({}));
    expect(none.status).toBe(404);
    const bad = await call(
      resend.POST as APIRoute,
      'POST',
      '/api/admin/users/x/resend',
      session({ reads: { profiles: pendingProfile } }),
      undefined,
      { id: 'x' },
    );
    expect(bad.status).toBe(404);
    expect(state.invites).toEqual([]);
  });

  it('GoTrue refusing the resend is a 422 the admin reads; nothing is audited', async () => {
    state.inviteError = { message: 'email rate limit exceeded', status: 429 };
    const res = await call(
      resend.POST as APIRoute,
      'POST',
      path,
      session({ reads: { profiles: pendingProfile } }),
    );
    expect(res.status).toBe(422);
    expect(state.audits).toEqual([]);
  });
});

describe('DELETE /api/admin/users/[id]/invite (cancel)', () => {
  const path = `/api/admin/users/${TARGET}/invite`;

  it('deletes an account that has not joined, audited by role', async () => {
    const res = await call(
      cancel.DELETE as APIRoute,
      'DELETE',
      path,
      session({ reads: { profiles: pendingProfile } }),
    );
    expect(res.status).toBe(200);
    expect(state.deleted).toEqual([TARGET]);
    expect(state.audits).toEqual([
      {
        action: 'user.invite_cancel',
        entityType: 'profile',
        entityId: TARGET,
        detail: { role: 'seo' },
      },
    ]);
    expect(JSON.stringify(state.audits)).not.toContain('new@x.test');
  });

  it('is refused once the person has joined, for the owner, for yourself, and elsewhere a 404', async () => {
    state.account = { ...state.account!, last_sign_in_at: '2026-10-15T00:00:00Z' };
    const joined = await call(
      cancel.DELETE as APIRoute,
      'DELETE',
      path,
      session({ reads: { profiles: pendingProfile } }),
    );
    expect(joined.status).toBe(422);
    expect(await bodyOf(joined)).toMatchObject({ detail: INVITE_ALREADY_JOINED });
    const theOwner = await call(
      cancel.DELETE as APIRoute,
      'DELETE',
      path,
      session({
        reads: {
          profiles: { data: { ...(pendingProfile.data as object), is_owner: true }, error: null },
        },
      }),
    );
    expect(await bodyOf(theOwner)).toMatchObject({ detail: OWNER_PROTECTED });
    const self = await call(
      cancel.DELETE as APIRoute,
      'DELETE',
      `/api/admin/users/${ADMIN}/invite`,
      session({ reads: { profiles: pendingProfile } }),
      undefined,
      { id: ADMIN },
    );
    expect(self.status).toBe(422);
    const elsewhere = await call(cancel.DELETE as APIRoute, 'DELETE', path, session({}));
    expect(elsewhere.status).toBe(404);
    state.account = null;
    const gone = await call(
      cancel.DELETE as APIRoute,
      'DELETE',
      path,
      session({ reads: { profiles: pendingProfile } }),
    );
    expect(gone.status).toBe(404);
    expect(state.deleted).toEqual([]);
    expect(state.audits).toEqual([]);
  });
});

describe('GET /api/admin/users: pending invites', () => {
  const OTHER = '33333333-3333-4333-8333-333333333333';
  const account = (id: string, pending: boolean) => ({
    id,
    email: `${id.slice(0, 4)}@x.test`,
    invited_at: pending ? '2026-10-14T00:00:00Z' : null,
    email_confirmed_at: pending ? null : '2026-01-01T00:00:00Z',
    last_sign_in_at: pending ? null : '2026-10-01T00:00:00Z',
    is_owner: false,
  });
  const profile = (id: string) => ({
    id,
    role: 'seo',
    is_active: true,
    display_name: null,
    locked_until: null,
    created_at: 'x',
    is_owner: false,
  });

  it('lists every account not yet joined, reading those beyond this page in one request', async () => {
    const sb = session({
      reads: { profiles: { data: [profile(ADMIN), profile(TARGET)], error: null } },
      rpc: {
        staff_accounts: {
          data: [account(ADMIN, false), account(TARGET, true), account(OTHER, true)],
          error: null,
        },
      },
    });
    const res = await call(users.GET as APIRoute, 'GET', '/api/admin/users', sb);
    const data = (await bodyOf(res))['data'] as { pending: { id: string; status: string }[] };
    // The stub answers every profiles read with this page's rows: OTHER is asked for, by id.
    expect(sb.calls).toContainEqual(['in', 'profiles', 'id', [OTHER]]);
    expect(data.pending.map((row) => [row.id, row.status])).toEqual([[TARGET, 'invited']]);
  });

  it('none when nobody is pending, or the directory cannot be read', async () => {
    const sb = session({
      reads: { profiles: { data: [profile(ADMIN)], error: null } },
      rpc: { staff_accounts: { data: [account(ADMIN, false)], error: null } },
    });
    const data = (await bodyOf(await call(users.GET as APIRoute, 'GET', '/api/admin/users', sb)))[
      'data'
    ] as { pending: unknown[] };
    expect(data.pending).toEqual([]);
    expect(sb.calls.filter((c) => c[0] === 'in')).toEqual([]);
    const down = session({
      reads: { profiles: { data: [profile(TARGET)], error: null } },
      rpc: { staff_accounts: { data: null, error: { message: 'down' } } },
    });
    const downData = (
      await bodyOf(await call(users.GET as APIRoute, 'GET', '/api/admin/users', down))
    )['data'] as { pending: unknown[] };
    expect(downData.pending).toEqual([]);
  });
});

// ── Two factor authentication (Admin v2 U17) ─────────────────────────────────────────────

describe('PUT /api/admin/users/security: Require 2FA for everyone', () => {
  const stored: Read = {
    data: { session_max_days: 7, invite_domain: null, require_mfa: false, version: 3 },
    error: null,
  };
  const body = (requireMfa?: boolean) => ({
    sessionMaxDays: 7,
    inviteDomain: null,
    version: 3,
    ...(requireMfa === undefined ? {} : { requireMfa }),
  });
  const ON = { twoStep: { on: true, required: false, factorId: TARGET } };

  it('turning it on is refused (422 requireMfa) unless the saving Admin uses 2FA (D5)', async () => {
    for (const extra of [{}, { twoStep: { on: false, required: false, factorId: null } }]) {
      const sb = session({ reads: { admin_security_settings: stored } });
      const res = await call(
        security.PUT as APIRoute,
        'PUT',
        '/api/admin/users/security',
        sb,
        body(true),
        { id: TARGET },
        extra,
      );
      expect(res.status).toBe(422);
      expect(await bodyOf(res)).toMatchObject({
        error: 'validation',
        field: 'requireMfa',
        detail: 'Turn on 2FA for your own account first.',
      });
      expect(sb.calls.filter((c) => c[0] === 'update' || c[0] === 'insert')).toEqual([]);
    }
    expect(state.audits).toEqual([]);
  });

  it('an Admin with 2FA on turns it on: saved at the version read, audited by field name', async () => {
    const sb = session({
      reads: { admin_security_settings: stored },
      writes: {
        admin_security_settings: {
          data: { session_max_days: 7, invite_domain: null, require_mfa: true, version: 4 },
          error: null,
        },
      },
    });
    const res = await call(
      security.PUT as APIRoute,
      'PUT',
      '/api/admin/users/security',
      sb,
      body(true),
      { id: TARGET },
      ON,
    );
    expect(res.status).toBe(200);
    expect(sb.calls).toContainEqual([
      'update',
      'admin_security_settings',
      { session_max_days: 7, invite_domain: null, require_mfa: true },
    ]);
    expect(state.audits).toEqual([
      expect.objectContaining({ detail: { fields: ['require_mfa'] } }),
    ]);
    expect((await bodyOf(res))['data']).toMatchObject({ requireMfa: true, version: 4 });
  });

  it('turning it off, or keeping it on, needs no 2FA of the saver (nobody is locked in)', async () => {
    const on: Read = { data: { ...(stored.data as object), require_mfa: true }, error: null };
    let sb = session({
      reads: { admin_security_settings: on },
      writes: { admin_security_settings: stored },
    });
    let res = await call(
      security.PUT as APIRoute,
      'PUT',
      '/api/admin/users/security',
      sb,
      body(false),
    );
    expect(res.status).toBe(200);
    expect(sb.calls).toContainEqual([
      'update',
      'admin_security_settings',
      { session_max_days: 7, invite_domain: null, require_mfa: false },
    ]);
    // A card loaded before U17 posts no requireMfa: the stored value is kept, and nothing
    // changed, so nothing is written.
    sb = session({ reads: { admin_security_settings: on } });
    res = await call(security.PUT as APIRoute, 'PUT', '/api/admin/users/security', sb, body());
    expect(res.status).toBe(200);
    expect(sb.calls.filter((c) => c[0] === 'update')).toEqual([]);
  });
});

describe('POST /api/admin/users/[id]/two-step-reset', () => {
  const reset = (sb: ReturnType<typeof session>, id = TARGET) =>
    call(
      twoStepReset.POST as APIRoute,
      'POST',
      `/api/admin/users/${id}/two-step-reset`,
      sb,
      undefined,
      { id },
    );

  it('resets through public.reset_two_step, which audits it; the route writes no row', async () => {
    const sb = session({ rpc: { reset_two_step: { data: 2, error: null } } });
    const res = await reset(sb);
    expect(res.status).toBe(200);
    expect((await bodyOf(res))['data']).toEqual({ factors: 2 });
    expect(sb.calls).toEqual([['rpc', 'reset_two_step', { p_tenant: TENANT, p_user: TARGET }]]);
    expect(state.audits).toEqual([]);
  });

  it('never your own: refused before the database is asked', async () => {
    const sb = session({});
    const res = await reset(sb, ADMIN);
    expect(res.status).toBe(422);
    expect(await bodyOf(res)).toMatchObject({ field: 'two-step' });
    expect(sb.calls).toEqual([]);
  });

  it.each([
    ['owner_protected', { code: '42501', message: 'owner_protected' }, 422, 'owner-protected'],
    ['a stale Admin', { code: '42501', message: 'reset_two_step: not a live Admin' }, 403, null],
    ['self', { code: '22023', message: 'self' }, 422, 'two-step'],
    ['nothing_to_reset', { code: '22023', message: 'nothing_to_reset' }, 409, null],
    ['not_found', { code: '22023', message: 'not_found' }, 404, null],
    ['anything else', { code: 'XX000', message: 'boom' }, 500, null],
  ] as const)('the database refusing (%s) is answered', async (_label, error, status, field) => {
    const sb = session({ rpc: { reset_two_step: { data: null, error } } });
    const res = await reset(sb);
    expect(res.status).toBe(status);
    if (field) expect(await bodyOf(res)).toMatchObject({ field });
    expect(state.audits).toEqual([]);
  });

  it('a path that is not an id is a 404, and nothing is asked', async () => {
    const sb = session({});
    const res = await reset(sb, 'nope');
    expect(res.status).toBe(404);
    expect(sb.calls).toEqual([]);
  });
});
