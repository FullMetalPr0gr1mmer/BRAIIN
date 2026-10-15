import { z } from 'zod';
import { RoleSchema } from '@schemas/admin';
import { DisplayNameValueSchema } from '@schemas/adminPrefs';
import { defineAdminRoute } from '@/lib/admin/route';
import { NotFoundError, ValidationError } from '@/lib/admin/errors';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { AuthorizationError } from '@/lib/authz/errors';
import { serviceClient } from '@/lib/supabase/server';

// Change a colleague's role, or deactivate them. `users.manage` — Admin only.
//
// ── Why the JWT claim and the profile row are written together ───────────────────
// Postgres RLS reads `app_metadata.role` out of the JWT; assertCap reads
// `profiles.role`. Writing only the row would demote someone at the second layer while
// the first one carried on enforcing their old, higher role until the token expired.
// So both are written, and `resolveAuthContext` treats any disagreement between them as
// a dead session — which is what turns a role change into an immediate, effective
// revocation rather than one that takes up to an hour.
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
      .select('id,role,is_active')
      .eq('tenant_id', auth.tenantId)
      .eq('id', id)
      .maybeSingle<{ id: string; role: string; is_active: boolean }>();
    if (readError) throw new Error(`read profile: ${readError.message}`);
    if (!target) throw new NotFoundError('profile');

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
    if (updateError) throw new Error(`update profile: ${updateError.message}`);
    // RLS skips a row it will not let this session write rather than raising, so a refused
    // write looks like a successful one. The read above found the profile, so no row back
    // means the database refused the session: the live check (0050) wants the token's role to
    // be the profile's, active, unlocked and in this tenant, which liveRecheck does not see
    // (it compares the profile with the session, not with the token). Nothing changed, so
    // nothing is stamped into the person's claims and nothing is audited.
    if (!Array.isArray(updated) || updated.length === 0) {
      throw new AuthorizationError('users.manage', 'the database refused this session');
    }

    if (input.role !== undefined) {
      const { error: claimError } = await serviceClient().auth.admin.updateUserById(id, {
        app_metadata: { role: input.role, tenant_id: auth.tenantId },
      });
      // Loud, not silent: the row now says one thing and the token another, and
      // resolveAuthContext will lock the user out until this is fixed. Better a 500 the
      // admin sees than a colleague mysteriously unable to log in.
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

    return { id, ...values };
  },
});
