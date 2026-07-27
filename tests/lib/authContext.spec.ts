import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// Live-recheck regression suite (CLAUDE.md §9(b)): "demote without refresh → export/lead/
// user-management endpoints 403 immediately".
//
// The property under test is the one documented in src/lib/auth/context.ts: when the
// JWT's claims and the profile row disagree, the session is INVALID rather than
// downgraded. Downgrading only assertCap would leave Postgres RLS — which reads the
// stale JWT — still enforcing the old, higher role.

let profileResult: { data: unknown; error: unknown } = { data: null, error: null };

vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => profileResult }),
          maybeSingle: async () => profileResult,
        }),
      }),
    }),
  }),
}));

const { resolveAuthContext } = await import('@/lib/auth/context');
const { liveRecheck } = await import('@/lib/admin/liveRecheck');

const USER = '11111111-1111-4111-8111-111111111111';
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function clientWithClaims(appMetadata: unknown, user: unknown = { id: USER, email: 'a@b.test' }) {
  return {
    auth: {
      getUser: async () => ({
        data: { user: user === null ? null : { ...(user as object), app_metadata: appMetadata } },
        error: null,
      }),
    },
  } as unknown as SupabaseClient;
}

const activeProfile = (role: string, tenant = TENANT) => ({
  data: { tenant_id: tenant, role, is_active: true, locked_until: null },
  error: null,
});

describe('resolveAuthContext', () => {
  beforeEach(() => {
    profileResult = activeProfile('admin');
  });

  it('returns a context when the JWT and the profile row agree', async () => {
    const result = await resolveAuthContext(clientWithClaims({ role: 'admin', tenant_id: TENANT }));
    expect(result.ctx).toEqual({
      userId: USER,
      tenantId: TENANT,
      role: 'admin',
      isActive: true,
      email: 'a@b.test',
    });
    expect(result.revoke).toBe(false);
  });

  it('treats no session as anonymous, not as something to revoke', async () => {
    const result = await resolveAuthContext(clientWithClaims({}, null));
    expect(result.ctx).toBeNull();
    expect(result.revoke).toBe(false);
  });

  it('rejects a role read from user_metadata rather than app_metadata', async () => {
    // The client passes app_metadata with no role; a role living anywhere else must not
    // be honoured, because user_metadata is writable by the user themselves.
    const result = await resolveAuthContext(clientWithClaims({ tenant_id: TENANT }));
    expect(result.ctx).toBeNull();
  });

  it('rejects a claim with no tenant', async () => {
    const result = await resolveAuthContext(clientWithClaims({ role: 'admin' }));
    expect(result.ctx).toBeNull();
  });

  it('REVOKES when the profile role no longer matches the JWT (demotion)', async () => {
    profileResult = activeProfile('seo');
    const result = await resolveAuthContext(clientWithClaims({ role: 'admin', tenant_id: TENANT }));
    // Not "downgraded to seo" — denied. RLS would still be enforcing `admin` from the
    // unchanged JWT, so a downgrade of only the second layer is not a demotion at all.
    expect(result.ctx).toBeNull();
    expect(result.revoke).toBe(true);
  });

  it('REVOKES when the profile tenant no longer matches the JWT', async () => {
    profileResult = activeProfile('admin', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const result = await resolveAuthContext(clientWithClaims({ role: 'admin', tenant_id: TENANT }));
    expect(result.ctx).toBeNull();
    expect(result.revoke).toBe(true);
  });

  it('REVOKES a deactivated account', async () => {
    profileResult = {
      data: { tenant_id: TENANT, role: 'admin', is_active: false, locked_until: null },
      error: null,
    };
    const result = await resolveAuthContext(clientWithClaims({ role: 'admin', tenant_id: TENANT }));
    expect(result.ctx).toBeNull();
    expect(result.revoke).toBe(true);
  });

  it('REVOKES a locked account and admits it once the lock expires', async () => {
    const future = new Date(Date.now() + 600_000).toISOString();
    profileResult = {
      data: { tenant_id: TENANT, role: 'admin', is_active: true, locked_until: future },
      error: null,
    };
    expect(
      (await resolveAuthContext(clientWithClaims({ role: 'admin', tenant_id: TENANT }))).ctx,
    ).toBeNull();

    const past = new Date(Date.now() - 600_000).toISOString();
    profileResult = {
      data: { tenant_id: TENANT, role: 'admin', is_active: true, locked_until: past },
      error: null,
    };
    expect(
      (await resolveAuthContext(clientWithClaims({ role: 'admin', tenant_id: TENANT }))).ctx,
    ).not.toBeNull();
  });

  it('FAILS CLOSED when the profile table is unreadable', async () => {
    // An outage in the component that answers "is this person still allowed" must not
    // become permission. Falling back to the JWT here would silently re-enable every
    // account that had just been disabled.
    profileResult = { data: null, error: { message: 'connection refused' } };
    const result = await resolveAuthContext(clientWithClaims({ role: 'admin', tenant_id: TENANT }));
    expect(result.ctx).toBeNull();
    expect(result.revoke).toBe(true);
  });

  it('FAILS CLOSED when the profile row has vanished', async () => {
    profileResult = { data: null, error: null };
    const result = await resolveAuthContext(clientWithClaims({ role: 'admin', tenant_id: TENANT }));
    expect(result.ctx).toBeNull();
    expect(result.revoke).toBe(true);
  });
});

describe('liveRecheck (privileged endpoints)', () => {
  const ctx = {
    userId: USER,
    tenantId: TENANT,
    role: 'developer' as const,
    isActive: true,
    email: 'd@b.test',
  };

  it('passes when the profile still agrees', async () => {
    profileResult = activeProfile('developer');
    await expect(liveRecheck(ctx)).resolves.toBeUndefined();
  });

  it('throws the moment the role has changed under an open session', async () => {
    profileResult = activeProfile('content_creator');
    await expect(liveRecheck(ctx)).rejects.toThrow(/role changed/);
  });

  it('throws for a deactivated account', async () => {
    profileResult = {
      data: { role: 'developer', is_active: false, locked_until: null },
      error: null,
    };
    await expect(liveRecheck(ctx)).rejects.toThrow(/disabled/);
  });

  it('throws for a locked account', async () => {
    const future = new Date(Date.now() + 600_000).toISOString();
    profileResult = {
      data: { role: 'developer', is_active: true, locked_until: future },
      error: null,
    };
    await expect(liveRecheck(ctx)).rejects.toThrow(/locked/);
  });

  it('throws — never passes — when the check itself fails', async () => {
    profileResult = { data: null, error: { message: 'down' } };
    await expect(liveRecheck(ctx)).rejects.toThrow(/unreadable/);
  });
});
