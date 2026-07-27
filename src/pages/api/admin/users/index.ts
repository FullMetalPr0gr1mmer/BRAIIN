import { UserInviteSchema } from '@schemas/admin';
import { defineAdminRoute } from '@/lib/admin/route';
import { ValidationError } from '@/lib/admin/errors';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { serviceClient } from '@/lib/supabase/server';
import { ListQuerySchema } from '@schemas/admin';
import { listRows } from '@/lib/admin/crud';

// User & role administration — `users.manage`, which §5 grants to Admin ALONE. Note
// that Developer, the "full technical access" role, is deliberately excluded: it can
// read every log and export every lead, but it cannot mint itself a second admin.
//
// This is one of the few places the service-role client is used, because creating an
// auth user is a GoTrue admin operation that RLS has no say over. Everything it does is
// therefore fenced by hand: liveRecheck immediately before, an explicit tenant stamp on
// the profile, and an audit row.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'users.manage',
  input: ListQuerySchema,
  handler: async ({ auth, sb, input }) => {
    // Read through the RLS-bound client: `profiles_self_select` already limits this to
    // admins within the tenant, so the primary layer is doing the work rather than
    // being bypassed for convenience.
    const { rows, total } = await listRows<Record<string, unknown>>(sb, 'profiles', auth, {
      columns: 'id,role,is_active,display_name,avatar_url,locked_until,last_login_at,created_at',
      orderBy: { column: 'created_at', ascending: true },
      limit: input.limit,
      offset: input.offset,
    });
    return { rows, total, limit: input.limit, offset: input.offset };
  },
});

export const POST = defineAdminRoute({
  cap: 'users.manage',
  input: UserInviteSchema,
  handler: async ({ auth, input, audit }) => {
    await liveRecheck(auth);
    const admin = serviceClient();

    // The role and tenant go into app_metadata, NEVER user_metadata: the Custom Access
    // Token Hook reads app_metadata to stamp the JWT that RLS then trusts, and
    // user_metadata is writable by the user themselves. Putting a role there would be
    // handing every account a self-service promotion button.
    const { data, error } = await admin.auth.admin.inviteUserByEmail(input.email, {
      data: {},
    });
    if (error || !data.user) {
      throw new ValidationError(error?.message ?? 'could not invite user', 'email');
    }

    const userId = data.user.id;
    const { error: metaError } = await admin.auth.admin.updateUserById(userId, {
      app_metadata: { role: input.role, tenant_id: auth.tenantId },
    });
    if (metaError) throw new Error(`stamp claims: ${metaError.message}`);

    const { error: profileError } = await admin.from('profiles').insert({
      id: userId,
      tenant_id: auth.tenantId,
      role: input.role,
      is_active: true,
      display_name: input.displayName ?? null,
    });
    if (profileError) throw new Error(`create profile: ${profileError.message}`);

    audit({
      action: 'user.invite',
      entityType: 'profile',
      entityId: userId,
      // The email is the identifier of a colleague, not lead PII, and "who was invited"
      // is the whole point of the record.
      detail: { role: input.role, email: input.email },
    });
    return { id: userId, role: input.role, email: input.email };
  },
});
