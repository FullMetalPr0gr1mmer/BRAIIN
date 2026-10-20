import { SecuritySettingsSchema } from '@schemas/users';
import { defineAdminRoute } from '@/lib/admin/route';
import { OptimisticLockError, ValidationError } from '@/lib/admin/errors';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { AuthorizationError } from '@/lib/authz/errors';
import { REQUIRE_MFA_SELF_FIRST, securityFromRow } from '@/lib/admin/users';

// The users screen's Security card (Admin v2 U12a): the session length (1 or 7 days, which
// resolveAuthContext enforces on every admin request) and the domain invites may go to; since
// U17 (0072) "Require 2FA for everyone", which resolveAuthContext and the access-token hook
// enforce. Turning it ON is refused (422, field requireMfa) unless the saving Admin uses 2FA
// in this session (decision D5: `auth.twoStep.on`, which a full session has only at aal2), so
// nobody switches it on and is sent to set it up mid-save. Omitted, it is left as stored.
// `users.manage`, Admin only, in both layers: admin_security_settings' policies (0055) want
// an Admin token AND a live Admin profile. Immediate (P-3): no release, no history row.
//
// One row per tenant, created by the first save. GET answers version 0 while there is none,
// and a save carries the version it read: 0 (or 1, H7) creates the row, anything else must
// match it (409 otherwise, also when someone else created it first).

export const prerender = false;

const COLUMNS = 'session_max_days,invite_domain,require_mfa,version';

export const GET = defineAdminRoute({
  cap: 'users.manage',
  handler: async ({ auth, sb }) => {
    const { data, error } = await sb
      .from('admin_security_settings')
      .select(COLUMNS)
      .eq('tenant_id', auth.tenantId)
      .maybeSingle<Record<string, unknown>>();
    if (error) throw new Error(`read security settings: ${error.message}`);
    return securityFromRow(data ?? null);
  },
});

/** 42501 is the database refusing this session (the live check): an authorization outcome. */
function rethrow(verb: string, error: { code?: string; message: string }): never {
  if (error.code === '42501') {
    throw new AuthorizationError('users.manage', 'the database refused this session');
  }
  if (error.code === '23514') throw new ValidationError('That setting is not allowed.');
  throw new Error(`${verb} security settings: ${error.message}`);
}

export const PUT = defineAdminRoute({
  cap: 'users.manage',
  input: SecuritySettingsSchema,
  handler: async ({ auth, sb, input, audit }) => {
    await liveRecheck(auth);

    const { data: existing, error: readError } = await sb
      .from('admin_security_settings')
      .select(COLUMNS)
      .eq('tenant_id', auth.tenantId)
      .maybeSingle<Record<string, unknown>>();
    if (readError) rethrow('read', readError);
    const before = securityFromRow(existing ?? null);
    const requireMfa = input.requireMfa ?? before.requireMfa;
    if (requireMfa && !before.requireMfa && auth.twoStep?.on !== true) {
      throw new ValidationError(REQUIRE_MFA_SELF_FIRST, 'requireMfa');
    }
    const values = {
      session_max_days: input.sessionMaxDays,
      invite_domain: input.inviteDomain,
      require_mfa: requireMfa,
    };
    const fields = [
      ...(before.sessionMaxDays !== input.sessionMaxDays ? ['session_max_days'] : []),
      ...(before.inviteDomain !== input.inviteDomain ? ['invite_domain'] : []),
      ...(before.requireMfa !== requireMfa ? ['require_mfa'] : []),
    ];

    let row: Record<string, unknown> | null;
    if (!existing) {
      // 0 is what GET reported for the row that does not exist yet (1 is accepted too,
      // H7's rule for singletons); anything else was read from a row someone else made.
      if (input.version !== 0 && input.version !== 1) throw new OptimisticLockError('security');
      const { data, error } = await sb
        .from('admin_security_settings')
        .insert({ tenant_id: auth.tenantId, ...values })
        .select(COLUMNS)
        .single<Record<string, unknown>>();
      if (error) {
        // 23505: another Admin created the row between the read and this write.
        if (error.code === '23505') throw new OptimisticLockError('security');
        rethrow('create', error);
      }
      row = data;
    } else {
      if (before.version !== input.version) throw new OptimisticLockError('security');
      if (fields.length === 0) return before;
      const { data, error } = await sb
        .from('admin_security_settings')
        .update(values)
        .eq('tenant_id', auth.tenantId)
        .eq('version', input.version)
        .select(COLUMNS)
        .maybeSingle<Record<string, unknown>>();
      if (error) rethrow('update', error);
      if (!data) throw new OptimisticLockError('security');
      row = data;
    }

    audit({
      action: 'user.security_update',
      entityType: 'security_settings',
      entityId: auth.tenantId,
      // Field names only, never values (the activity log shows details so).
      detail: { fields },
    });
    return securityFromRow(row);
  },
});
