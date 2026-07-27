import { z } from 'zod';
import { RoleSchema } from '@schemas/admin';
import { defineAdminRoute } from '@/lib/admin/route';
import { NotFoundError, ValidationError } from '@/lib/admin/errors';
import { liveRecheck } from '@/lib/admin/liveRecheck';
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
  displayName: z.string().trim().max(120).nullish(),
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

    const { error: updateError } = await sb
      .from('profiles')
      .update(values)
      .eq('tenant_id', auth.tenantId)
      .eq('id', id);
    if (updateError) throw new Error(`update profile: ${updateError.message}`);

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
