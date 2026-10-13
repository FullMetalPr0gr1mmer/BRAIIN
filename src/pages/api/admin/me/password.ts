import { PasswordChangeSchema } from '@schemas/adminPrefs';
import { PASSWORD_REFUSALS, changeMyPassword } from '@/lib/admin/account';
import { defineAdminRoute, json } from '@/lib/admin/route';
import { LOCKOUT_DURATION_MINUTES } from '@/lib/auth/lockout';
import { clientIp } from '@/lib/http/maintenance';

// POST /api/admin/me/password: the signed-in person changes their password (Admin v2 F8,
// CLAUDE.md §3). Re-authenticates with the current password first (a wrong one counts
// toward the sign-in lockout; the fifth answers 423 like the sign-in does), then sets the
// new one and signs out every other session. A refused current password and the change
// are audited inside changeMyPassword(); an auth server that cannot answer is a 502 and
// counts nothing. No password is ever echoed, logged or audited. These are this route's
// checks: Supabase Auth's own endpoint is the residual in docs/admin-v2/deviations.md (O-24).

export const prerender = false;

export const POST = defineAdminRoute({
  cap: 'analytics.read',
  input: PasswordChangeSchema,
  handler: async ({ auth, sb, input, request }) => {
    const outcome = await changeMyPassword(sb, auth, input, clientIp(request));
    if (outcome.ok) return { changed: true, othersSignedOut: outcome.othersSignedOut };
    const { field, message } = PASSWORD_REFUSALS[outcome.reason];
    if (outcome.reason === 'locked') {
      return json(
        {
          ok: false,
          error: 'locked',
          retryAfterMinutes: LOCKOUT_DURATION_MINUTES,
          detail: message,
        },
        423,
      );
    }
    if (outcome.reason === 'failed')
      return json({ ok: false, error: 'server', detail: message }, 502);
    return json({ ok: false, error: 'validation', field, detail: message }, 422);
  },
});
