import { z } from 'zod';
import { RoleSchema } from '@schemas/admin';
import { DisplayNameValueSchema } from '@schemas/adminPrefs';
import { defineAdminRoute } from '@/lib/admin/route';
import { NotFoundError, ValidationError } from '@/lib/admin/errors';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { AuthorizationError } from '@/lib/authz/errors';
import { serviceClient } from '@/lib/supabase/server';
import { writeSystemLog } from '@/lib/data/systemLog';
import {
  OWNER_PROTECTED,
  OWNER_PROTECTED_CODE,
  isOwnerGuardError,
  ownerRefusal,
} from '@/lib/admin/users';

// Change a colleague's role, or deactivate them. `users.manage` — Admin only.
//
// ── What a role or activity change does ─────────────────────────────────────────
// Postgres RLS reads `app_metadata.role` out of the access token; assertCap reads
// `profiles.role`. Changing the row ends every session of that person in the database
// (profiles_revoke_sessions, 0055), so their next request finds no session and they sign
// in again; the next token the access-token hook mints carries the new role. Their current
// token, until then, disagrees with the profile, and resolveAuthContext revokes a session
// whose token's claims and profile disagree (the second layer). `app_metadata` is stamped
// too, for an environment whose hook is off (the claims then come from it).
//
// ── The account owner (0055) ─────────────────────────────────────────────────────
// The owner cannot be demoted or switched off by anyone: refused here (422) before the
// database, whose guard trigger is the second layer (its 42501 `owner_protected` answers
// the same 422). The owner hands ownership on through POST ./[id]/owner.
//
// ── Why you cannot demote or disable yourself ────────────────────────────────────
// Not paternalism: `users.manage` is Admin-only, so an admin removing their own admin
// role in a single-admin tenant leaves NOBODY who can grant it back. That is an
// unrecoverable state reachable by one mis-click, and the recovery involves the
// service-role key and a SQL console.

export const prerender = false;

const PatchSchema = z.object({
  role: RoleSchema.optional(),
  isActive: z.boolean().optional(),
  // The one display-name rule; the database's trigger (0044) holds this path to it too.
  displayName: DisplayNameValueSchema.nullish(),
});

export const PATCH = defineAdminRoute({
  cap: 'users.manage',
  input: PatchSchema,
  handler: async ({ auth, sb, input, params, audit }) => {
    const id = params['id'];
    if (!id || !z.string().uuid().safeParse(id).success) throw new NotFoundError('profile');

    await liveRecheck(auth);

    if (id === auth.userId && (input.role !== undefined || input.isActive === false)) {
      throw new ValidationError('you cannot change your own role or deactivate yourself');
    }

    // Tenant-scoped read through RLS first: this is what stops an admin of tenant A
    // from editing a profile in tenant B by pasting its uuid.
    const { data: target, error: readError } = await sb
      .from('profiles')
      .select('id,role,is_active,is_owner')
      .eq('tenant_id', auth.tenantId)
      .eq('id', id)
      .maybeSingle<{ id: string; role: string; is_active: boolean; is_owner?: boolean }>();
    if (readError) throw new Error(`read profile: ${readError.message}`);
    if (!target) throw new NotFoundError('profile');
    if (ownerRefusal(target, input))
      throw new ValidationError(OWNER_PROTECTED, OWNER_PROTECTED_CODE);

    const values: Record<string, unknown> = {};
    if (input.role !== undefined) values['role'] = input.role;
    if (input.isActive !== undefined) values['is_active'] = input.isActive;
    if (input.displayName !== undefined) values['display_name'] = input.displayName;
    if (Object.keys(values).length === 0) {
      throw new ValidationError('no updatable fields supplied');
    }

    const { data: updated, error: updateError } = await sb
      .from('profiles')
      .update(values)
      .eq('tenant_id', auth.tenantId)
      .eq('id', id)
      .select('id');
    if (updateError) {
      if (isOwnerGuardError(updateError)) {
        throw new ValidationError(OWNER_PROTECTED, OWNER_PROTECTED_CODE);
      }
      throw new Error(`update profile: ${updateError.message}`);
    }
    // RLS skips a row it will not let this session write rather than raising, so a refused
    // write looks like a successful one. No row back means one of two things: the profile went
    // between the read above and the write (404), or the database refused the session: the
    // live check (0050) wants the token's role to be the profile's, active, unlocked and in
    // this tenant, which liveRecheck does not see (it compares the profile with the session,
    // not with the token). Either way nothing changed, so nothing is stamped into the person's
    // claims and nothing is audited; a refusal is logged, naming the target only.
    if (!Array.isArray(updated) || updated.length === 0) {
      if (!(await profileExists(auth.tenantId, id))) throw new NotFoundError('profile');
      await writeSystemLog({
        level: 'warn',
        source: 'admin:users.manage',
        message: 'profile write refused by the database for this session',
        detail: { target: id },
      });
      throw new AuthorizationError('users.manage', 'the database refused this session');
    }

    if (input.role !== undefined) {
      const { error: claimError } = await serviceClient().auth.admin.updateUserById(id, {
        app_metadata: { role: input.role, tenant_id: auth.tenantId },
      });
      // Loud, not silent: where the access-token hook is off, the claims come from
      // app_metadata, and a stale one would lock the person out until this is fixed.
      // Better a 500 the admin sees than a colleague mysteriously unable to sign in.
      if (claimError) throw new Error(`stamp claims: ${claimError.message}`);
    }

    audit({
      action: input.isActive === false ? 'user.deactivate' : 'user.update',
      entityType: 'profile',
      entityId: id,
      detail: {
        from: target.role,
        to: input.role ?? target.role,
        isActive: input.isActive ?? target.is_active,
      },
    });

    // A changed role or activity has ended every session of that person (0055): the screen
    // says so.
    const signedOut =
      (input.role !== undefined && input.role !== target.role) ||
      (input.isActive !== undefined && input.isActive !== target.is_active);
    return { id, ...values, signedOut };
  },
});

/**
 * Whether the profile is still there, read as the service role (tenant-scoped here), so the
 * answer does not depend on what this session's RLS lets it see. An unreadable table counts
 * as present: the caller then answers the refusal, never a 404 it cannot vouch for.
 */
async function profileExists(tenantId: string, id: string): Promise<boolean> {
  try {
    const { data, error } = await serviceClient()
      .from('profiles')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('id', id)
      .maybeSingle<{ id: string }>();
    if (error) return true;
    return data !== null;
  } catch {
    return true;
  }
}
