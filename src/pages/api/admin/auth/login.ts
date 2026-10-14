import type { APIRoute } from 'astro';
import { LoginSchema } from '@schemas/admin';
import { resolveAuthContext } from '@/lib/auth/context';
import {
  chooseSessionPersistence,
  clearSessionCookies,
  commitSessionPersistence,
} from '@/lib/auth/session';
import {
  isLockedOut,
  registerFailure,
  registerSuccess,
  LOCKOUT_DURATION_MINUTES,
} from '@/lib/auth/lockout';
import { readAuthBody, seeOther, ticked } from '@/lib/auth/body';
import { safeNext } from '@/lib/auth/next';
import { clientIp } from '@/lib/http/maintenance';
import { writeAudit } from '@/lib/admin/audit';
import { json } from '@/lib/admin/route';

// Admin sign-in. Reached without a session (the middleware's pre-auth paths) but still
// behind the same-origin + `__Host-csrf` double-submit check, because logging a victim
// into an ACCOUNT THE ATTACKER CONTROLS is a real CSRF target — everything the victim
// then does in "their" CMS happens in the attacker's session.
//
// Two callers (src/lib/auth/body.ts). A script posts JSON and gets JSON: 200, the generic
// 401, or the 423 lockout. The sign-in screen is a zero-JS form (Admin v2 F7), and its
// post gets a 303: to the `next` page on success, else back to /admin/login with an
// `error` code the page renders (`invalid`, `locked`, `unavailable`). The address is
// never put in that URL.
//
// ── One message for every failure ────────────────────────────────────────────────
// Wrong password, unknown email, deactivated profile and no-role-claim all answer 401
// with the same body (the form: the same `invalid` code). Distinguishing them turns the
// form into an account-enumeration oracle, and knowing which staff emails exist is step
// one of a phishing campaign against a CMS whose Admin role can publish to the company's
// homepage.
//
// The one deliberate exception is 423, which CLAUDE.md §3 requires for lockout. It
// reveals only that THIS address has already accumulated five failures — something the
// party who made those five attempts necessarily knows.
//
// "Keep me signed in" (`remember`, on unless a JSON caller sends false; a form sends the
// box only when it is ticked) decides the session cookie's lifetime: src/lib/auth/session.ts.

export const prerender = false;

const LOGIN_PAGE = '/admin/login';
const GENERIC_FAILURE = { ok: false, error: 'invalid-credentials' } as const;
const LOCKED = { ok: false, error: 'locked', retryAfterMinutes: LOCKOUT_DURATION_MINUTES } as const;

/** The login page with an outcome code, keeping where the person was going. */
function loginPage(error: 'invalid' | 'locked' | 'unavailable', next: string): string {
  const params = new URLSearchParams({ error });
  if (next !== '/admin') params.set('next', next);
  return `${LOGIN_PAGE}?${params}`;
}

export const POST: APIRoute = async ({ request, locals, cookies }) => {
  const body = await readAuthBody(request);
  if (!body) return json({ ok: false, error: 'bad-request' }, 400);

  const form = body.kind === 'form';
  const next = form ? safeNext(body.fields['next']) : '/admin';
  const fail = (status: 401 | 423 | 500, code: 'invalid' | 'locked' | 'unavailable') =>
    form
      ? seeOther(loginPage(code, next))
      : json(
          status === 423
            ? LOCKED
            : status === 401
              ? GENERIC_FAILURE
              : { ok: false, error: 'server' },
          status,
        );

  const supabase = locals.supabase;
  if (!supabase) return fail(500, 'unavailable');

  const parsed = LoginSchema.safeParse(
    form
      ? {
          email: body.fields['email'],
          password: body.fields['password'],
          remember: ticked(body.fields, 'remember'),
        }
      : body.fields,
  );
  // Not 422-with-issues: a schema error here tells the caller which field was wrong,
  // which is more than a failed login should ever say.
  if (!parsed.success) return fail(401, 'invalid');

  const { email, password, remember } = parsed.data;
  const ip = clientIp(request);

  if (await isLockedOut(email)) return fail(423, 'locked');

  // Before the sign-in: signInWithPassword writes the session cookie, and the cookie's
  // lifetime is read from this choice as it is written. Only for this request: the marker
  // the browser keeps changes below, once the sign-in has succeeded, so a failed attempt
  // leaves a session already open in this browser as it was.
  chooseSessionPersistence(cookies, remember);

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    const nowLocked = await registerFailure(email, ip);
    return nowLocked ? fail(423, 'locked') : fail(401, 'invalid');
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
    return fail(401, 'invalid');
  }

  commitSessionPersistence(cookies);
  await registerSuccess(email, ip);
  await writeAudit(supabase, ctx, {
    action: 'auth.login',
    entityType: 'profile',
    entityId: ctx.userId,
    detail: { ip: ip ?? null, remember },
  });

  return form ? seeOther(next) : json({ ok: true, data: { role: ctx.role, email: ctx.email } });
};
