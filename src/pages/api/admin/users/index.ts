import { UserInviteV2Schema } from '@schemas/users';
import { defineAdminRoute, json } from '@/lib/admin/route';
import { ValidationError } from '@/lib/admin/errors';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { claimPrivilegedOp } from '@/lib/admin/rateLimit';
import { authEmailReady, invitePageUrl } from '@/lib/auth/recovery';
import { serviceClient } from '@/lib/supabase/server';
import { ListQuerySchema } from '@schemas/admin';
import {
  INVITE_EXISTS,
  INVITE_LIMITS,
  INVITE_OP,
  inviteDomainOf,
  inviteDomainRefusal,
  loadUsers,
} from '@/lib/admin/users';

// User & role administration — `users.manage`, which §5 grants to Admin ALONE. Note
// that Developer, the "full technical access" role, is deliberately excluded: it can
// read every log and export every lead, but it cannot mint itself a second admin.
//
// This is one of the few places the service-role client is used, because creating an
// auth user is a GoTrue admin operation that RLS has no say over. Everything it does is
// therefore fenced by hand: liveRecheck immediately before, an explicit tenant stamp on
// the profile, and an audit row.
//
// ── Invites (Admin v2 U12b) ───────────────────────────────────────────────────────────
// An invite sends an e-mail, so it is switched off while the site cannot send one
// (AUTH_EMAIL_READY, owner items O-2 and O-22): a 503 `not-set-up`, before anything is read,
// counted or sent, and the screen says "Not set up". Switched on, it takes an optional
// message (packages/schemas/users.ts InviteMessageSchema, rendered into the e-mail by GoTrue
// from user metadata and cleared at acceptance), sends the link to /admin/invite, and counts
// against INVITE_LIMITS. The audit row names the role and whether there was a message, never
// the address (decision D5: the entity id is the person).

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'users.manage',
  input: ListQuerySchema,
  handler: async ({ auth, sb, input }) => {
    // Read through the RLS-bound client: profiles_self_select and, since 0055, the live
    // read (profiles_live_read) limit this to a live Admin of the tenant, so the primary
    // layer does the work rather than being bypassed for convenience. The e-mails and
    // sign-in times come from public.staff_accounts, which checks the same itself.
    const { rows, total, hasOwner, pending, withoutTwoStep } = await loadUsers(sb, auth, {
      limit: input.limit,
      offset: input.offset,
    });
    return {
      rows,
      total,
      limit: input.limit,
      offset: input.offset,
      hasOwner,
      pending,
      withoutTwoStep,
    };
  },
});

export const POST = defineAdminRoute({
  cap: 'users.manage',
  input: UserInviteV2Schema,
  handler: async ({ auth, sb, input, audit }) => {
    // Switched off until e-mail is set up: nothing below runs (the gate above still did).
    if (!authEmailReady()) return json({ ok: false, error: 'not-set-up' }, 503);

    await liveRecheck(auth);

    // The Security card's allowed domain (0055), read through the Admin's session: with one
    // set, only addresses at exactly that domain are invited.
    const refusal = inviteDomainRefusal(input.email, await inviteDomainOf(sb, auth.tenantId));
    if (refusal) throw new ValidationError(refusal, 'email');

    // An address that already has an account here is not invited again from this form:
    // GoTrue would re-send an unaccepted invite under its first role, or refuse a joined one.
    // Resend is the way for the first, and nothing is the way for the second. Read through
    // the directory (the live Admin's own view, 0055). An unreadable one refuses the invite
    // (fails closed): past this point GoTrue would send an existing account its link again.
    const { data: directory, error: directoryError } = await sb.rpc('staff_accounts', {
      p_tenant: auth.tenantId,
    });
    if (directoryError || !Array.isArray(directory)) {
      throw new Error(`read directory: ${directoryError?.message ?? 'not a list'}`);
    }
    if (
      Array.isArray(directory) &&
      directory.some(
        (row: unknown) =>
          typeof (row as { email?: unknown }).email === 'string' &&
          (row as { email: string }).email.toLowerCase() === input.email,
      )
    ) {
      throw new ValidationError(INVITE_EXISTS, 'email');
    }

    // Counted before the e-mail goes, so an invite that fails halfway still spent its slot.
    await claimPrivilegedOp(auth, INVITE_OP, INVITE_LIMITS);

    const admin = serviceClient();

    // The role and tenant go into app_metadata, NEVER user_metadata: the Custom Access
    // Token Hook reads app_metadata to stamp the JWT that RLS then trusts, and
    // user_metadata is writable by the user themselves. Putting a role there would be
    // handing every account a self-service promotion button. The message is the one thing
    // in user_metadata, for the e-mail template alone, and nothing reads it for access.
    const message = input.message ?? null;
    const { data, error } = await admin.auth.admin.inviteUserByEmail(input.email, {
      redirectTo: invitePageUrl(),
      data: message === null ? {} : { invite_message: message },
    });
    if (error || !data.user) {
      throw new ValidationError(error?.message ?? 'could not invite user', 'email');
    }

    const userId = data.user.id;

    // The directory sees this tenant alone (up to 200 people). For an address it missed,
    // GoTrue answers with the existing account (re-sending an unaccepted one its link), so
    // before anything is stamped on it: an account that already has a profile, in any
    // tenant, is refused here, and its role, tenant and profile are left as they were.
    const { data: existing, error: existingError } = await admin
      .from('profiles')
      .select('id')
      .eq('id', userId)
      .maybeSingle();
    if (existingError) throw new Error(`check profile: ${existingError.message}`);
    if (existing) throw new ValidationError(INVITE_EXISTS, 'email');

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
    if (profileError) {
      // The account already had a profile (an invite the directory could not show).
      if (profileError.code === '23505') throw new ValidationError(INVITE_EXISTS, 'email');
      throw new Error(`create profile: ${profileError.message}`);
    }

    audit({
      action: 'user.invite',
      entityType: 'profile',
      entityId: userId,
      // Decision D5: no address (the entity id is the person) and not the message itself.
      detail: { role: input.role, withMessage: message !== null },
    });
    return { id: userId, role: input.role, email: input.email };
  },
});
