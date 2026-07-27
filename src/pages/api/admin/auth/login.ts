import type { APIRoute } from 'astro';
import { LoginSchema } from '@schemas/admin';
import { resolveAuthContext } from '@/lib/auth/context';
import { clearSessionCookies } from '@/lib/auth/session';
import {
  isLockedOut,
  registerFailure,
  registerSuccess,
  LOCKOUT_DURATION_MINUTES,
} from '@/lib/auth/lockout';
import { clientIp } from '@/lib/http/maintenance';
import { writeAudit } from '@/lib/admin/audit';
import { json } from '@/lib/admin/route';

// Admin sign-in. Reached without a session (middleware exempts this exact path) but
// still behind the same-origin + `__Host-csrf` double-submit check, because logging a
// victim into an ACCOUNT THE ATTACKER CONTROLS is a real CSRF target — everything the
// victim then does in "their" CMS happens in the attacker's session.
//
// ── One message for every failure ────────────────────────────────────────────────
// Wrong password, unknown email, deactivated profile and no-role-claim all answer 401
// with the same body. Distinguishing them turns the form into an account-enumeration
// oracle, and knowing which staff emails exist is step one of a phishing campaign
// against a CMS whose Admin role can publish to the company's homepage.
//
// The one deliberate exception is 423, which CLAUDE.md §3 requires for lockout. It
// reveals only that THIS address has already accumulated five failures — something the
// party who made those five attempts necessarily knows.

export const prerender = false;

const GENERIC_FAILURE = { ok: false, error: 'invalid-credentials' } as const;

export const POST: APIRoute = async ({ request, locals, cookies }) => {
  const supabase = locals.supabase;
  if (!supabase) return json({ ok: false, error: 'server' }, 500);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'bad-request' }, 400);
  }

  const parsed = LoginSchema.safeParse(body);
  // Not 422-with-issues: a schema error here tells the caller which field was wrong,
  // which is more than a failed login should ever say.
  if (!parsed.success) return json(GENERIC_FAILURE, 401);

  const { email, password } = parsed.data;
  const ip = clientIp(request);

  if (await isLockedOut(email)) {
    return json({ ok: false, error: 'locked', retryAfterMinutes: LOCKOUT_DURATION_MINUTES }, 423);
  }

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    const nowLocked = await registerFailure(email, ip);
    return nowLocked
      ? json({ ok: false, error: 'locked', retryAfterMinutes: LOCKOUT_DURATION_MINUTES }, 423)
      : json(GENERIC_FAILURE, 401);
  }

  // Authentication succeeded; authorisation has not been established yet. This re-runs
  // the full live-recheck (active, unlocked, JWT claims agreeing with the profile row),
  // so a user whose credentials are valid but whose account was disabled — or who never
  // had the access-token hook stamp a role — never receives a usable admin session.
  const { ctx } = await resolveAuthContext(supabase);
  if (!ctx) {
    await supabase.auth.signOut();
    clearSessionCookies(cookies);
    // Counts as a failure: repeated attempts against a disabled account should trip the
    // same lockout as repeated wrong passwords.
    await registerFailure(email, ip);
    return json(GENERIC_FAILURE, 401);
  }

  await registerSuccess(email, ip);
  await writeAudit(supabase, ctx, {
    action: 'auth.login',
    entityType: 'profile',
    entityId: ctx.userId,
    detail: { ip: ip ?? null },
  });

  return json({ ok: true, data: { role: ctx.role, email: ctx.email } });
};
