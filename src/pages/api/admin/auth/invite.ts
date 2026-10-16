import type { APIRoute } from 'astro';
import { RECOVERY_TOKEN_PATTERN, ResetPasswordSchema, newPasswordProblem } from '@schemas/admin';
import { readAuthBody, seeOther } from '@/lib/auth/body';
import { clearSessionCookies } from '@/lib/auth/session';
import { INVITE_PAGE, dropInviteToken, keepInviteToken } from '@/lib/auth/inviteToken';
import { checkInviteLimits, inviteeOf, recoveryClient, writeAuthAudit } from '@/lib/auth/recovery';
import { resolveLaunchTenantId } from '@/lib/data/tenant';
import { writeSystemLog } from '@/lib/data/systemLog';
import { clientIp } from '@/lib/http/maintenance';
import { json } from '@/lib/admin/route';

// Accepts an invite: sets the invited person's first password from the invite link (Admin v2
// U12b, the reset endpoint's pattern, src/pages/api/admin/auth/reset.ts). Reached without a
// session (the middleware's pre-auth paths), behind the same-origin + `__Host-csrf` check.
// The link's token arrives with the new password, and this request does everything on the
// server (src/lib/auth/recovery.ts, "The token never becomes a browser session"):
//
//   1. check the token's shape and the password (the admin's rule for a new password,
//      packages/schemas/admin.ts newPasswordProblem, typed twice);
//   2. count the attempt (per IP address, then the tenant's window; fail closed);
//   3. verify the token with Supabase (`type: 'invite'`), which confirms the address, opens
//      a session in this request's own client and spends the token;
//   4. check the account may still sign in (an Admin may have switched it off since the
//      invite went out): if not, end that session, set nothing;
//   5. set the password with that session, and clear the invite's message from the user's
//      metadata (it was only for the e-mail);
//   6. sign the account out everywhere, and clear any session cookie this browser holds;
//   7. audit it against the account, with the service role (`auth.invite_accepted`).
//
// Then the person signs in with the new password (/admin/login?invite=ready). Steps 1 and 2
// keep the token unspent, so the page shows the form again, and so does a verify that
// Supabase throttled or could not answer. After step 3 the token is spent: a refusal from
// then on needs a new invite (Resend, by an Admin), and the failure's status and code (never
// the password) go to system_logs. The person has never signed in, so step 6 has one session
// to end: the one the verify itself opened.
//
// Answers: JSON for a script (200, 400, 403, 422, 429, 503), a 303 for the page's form: to
// /admin/login?invite=ready, or back to /admin/invite with an `error` code. While the token
// is unspent it goes back in a cookie scoped to the page, never in the URL (request URLs are
// logged: src/lib/auth/inviteToken.ts); once it is spent, or the password is set, the cookie
// is dropped.
//
// It works whether or not e-mail is set up (AUTH_EMAIL_READY): a token can only come from an
// invite e-mail, or, in the e2e harness, GoTrue's admin API.

export const prerender = false;

type Failure =
  | 'invalid-link'
  | 'short'
  | 'long'
  | 'mismatch'
  | 'limited'
  | 'unavailable'
  | 'closed'
  | 'refused'
  | 'interrupted';

const FAILURE_STATUS: Record<Failure, number> = {
  'invalid-link': 400,
  short: 422,
  long: 422,
  mismatch: 422,
  limited: 429,
  unavailable: 503,
  closed: 403,
  refused: 422,
  interrupted: 503,
};

/** The page codes. A failure before the token is spent keeps it (in the page's cookie). */
const PAGE_CODE: Record<Failure, string> = {
  'invalid-link': 'expired',
  short: 'short',
  long: 'long',
  mismatch: 'mismatch',
  limited: 'limited',
  unavailable: 'unavailable',
  closed: 'closed',
  refused: 'refused',
  interrupted: 'interrupted',
};
const TOKEN_KEPT: ReadonlySet<Failure> = new Set([
  'short',
  'long',
  'mismatch',
  'limited',
  'unavailable',
]);

/** A spent invite link that set no password, for an operator: whose, and why, never more. */
async function logSpent(
  failure: 'closed' | 'refused' | 'interrupted',
  userId: string,
  detail: Record<string, unknown>,
) {
  await writeSystemLog({
    level: 'warn',
    source: 'auth.invite',
    message: 'An invite link was spent but no password was set',
    detail: { failure, userId, ...detail },
  });
}

export const POST: APIRoute = async ({ request, cookies }) => {
  const body = await readAuthBody(request);
  if (!body) return json({ ok: false, error: 'bad-request' }, 400);

  const rawToken = body.fields['token_hash'] ?? body.fields['token'];
  const token =
    typeof rawToken === 'string' && RECOVERY_TOKEN_PATTERN.test(rawToken) ? rawToken : null;

  const fail = (failure: Failure): Response => {
    if (body.kind === 'json') return json({ ok: false, error: failure }, FAILURE_STATUS[failure]);
    const res = seeOther(`${INVITE_PAGE}?${new URLSearchParams({ error: PAGE_CODE[failure] })}`);
    res.headers.append(
      'set-cookie',
      token && TOKEN_KEPT.has(failure) ? keepInviteToken(token) : dropInviteToken(),
    );
    return res;
  };

  if (!token) return fail('invalid-link');
  const password = body.fields['password'];
  if (typeof password !== 'string') return fail('short');
  const problem = newPasswordProblem(password);
  if (problem) return fail(problem);
  const parsed = ResetPasswordSchema.safeParse({
    token,
    password,
    confirm: body.fields['confirm'],
  });
  if (!parsed.success) return fail('mismatch');

  const ip = clientIp(request);
  const launchTenant = await resolveLaunchTenantId();
  if (!launchTenant) return fail('unavailable');
  const limited = await checkInviteLimits(launchTenant, ip);
  if (limited !== 'ok') return fail(limited === 'limited' ? 'limited' : 'unavailable');

  const client = recoveryClient();
  let userId: string;
  try {
    const { data, error } = await client.auth.verifyOtp({
      type: 'invite',
      token_hash: parsed.data.token,
    });
    // GoTrue's own throttle, its outage or the network (status 0, or none) leaves the token
    // unspent: say so, and keep it. Any other refusal is the link's.
    if (error) {
      const status = error.status ?? 0;
      if (status === 429) return fail('limited');
      if (status === 0 || status >= 500) return fail('unavailable');
      return fail('invalid-link');
    }
    if (!data.session || !data.user) return fail('invalid-link');
    userId = data.user.id;
  } catch {
    return fail('unavailable');
  }

  // Switched off, or no profile at all, since the invite went out: no password for it. The
  // session the verify opened is ended, and the link is spent. A profile that could not be
  // read is our outage, not the invite's: `interrupted`, whose words point at "Forgot
  // password?" (the account is confirmed now, so it cannot be invited again).
  const invitee = await inviteeOf(userId);
  if (invitee.kind !== 'found' || !invitee.isActive) {
    await client.auth.signOut({ scope: 'local' }).catch(() => undefined);
    if (invitee.kind === 'unreadable') {
      await logSpent('interrupted', userId, { profile: 'unreadable' });
      return fail('interrupted');
    }
    await logSpent('closed', userId, {
      profile: invitee.kind === 'found' ? 'inactive' : 'missing',
    });
    return fail('closed');
  }

  try {
    const { error } = await client.auth.updateUser({
      password: parsed.data.password,
      // The invite's message was for the e-mail alone (D9): cleared now. GoTrue deletes a
      // metadata key set to null.
      data: { invite_message: null },
    });
    if (error) {
      await client.auth.signOut({ scope: 'local' }).catch(() => undefined);
      const status = error.status ?? 0;
      const failure = status >= 400 && status < 500 && status !== 429 ? 'refused' : 'interrupted';
      await logSpent(failure, userId, { status, code: error.code ?? null });
      return fail(failure);
    }
  } catch (err) {
    await client.auth.signOut({ scope: 'local' }).catch(() => undefined);
    await logSpent('interrupted', userId, {
      thrown: err instanceof Error ? err.name : 'unknown',
    });
    return fail('interrupted');
  }

  // Everywhere: the session the verify opened included. The person signs in themselves next.
  let signedOutEverywhere = false;
  try {
    const { error } = await client.auth.signOut({ scope: 'global' });
    signedOutEverywhere = !error;
  } catch {
    signedOutEverywhere = false;
  }
  // And this browser, whoever it was signed in as: the next screen is the login page.
  clearSessionCookies(cookies);

  if (!signedOutEverywhere) {
    await writeSystemLog({
      level: 'error',
      source: 'auth.invite',
      message: 'An invite was accepted but its session could not be signed out',
      detail: { userId },
    });
  }

  // Against the account, never the token; no address, no message (decision D5).
  await writeAuthAudit({
    tenantId: invitee.tenantId,
    actorId: userId,
    actorRole: invitee.role,
    action: 'auth.invite_accepted',
    entityType: 'profile',
    entityId: userId,
    detail: { ip: ip ?? null, signedOutEverywhere },
  });

  if (body.kind === 'json') return json({ ok: true, data: { signedOutEverywhere } });
  const done = seeOther('/admin/login?invite=ready');
  done.headers.append('set-cookie', dropInviteToken());
  return done;
};
