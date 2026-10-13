import type { APIRoute } from 'astro';
import {
  NEW_PASSWORD_MAX,
  NEW_PASSWORD_MIN,
  RECOVERY_TOKEN_PATTERN,
  ResetPasswordSchema,
} from '@schemas/admin';
import { readAuthBody, seeOther } from '@/lib/auth/body';
import { clearSessionCookies } from '@/lib/auth/session';
import {
  checkRecoveryLimits,
  profileOf,
  recoveryClient,
  resetLimitRules,
  writeAuthAudit,
} from '@/lib/auth/recovery';
import { resolveLaunchTenantId } from '@/lib/data/tenant';
import { writeSystemLog } from '@/lib/data/systemLog';
import { clientIp } from '@/lib/http/maintenance';
import { json } from '@/lib/admin/route';

// Sets a new password from a reset link (Admin v2 F7, docs/admin-v2/ui.md AV-06). Reached
// without a session (the middleware's pre-auth paths), behind the same-origin +
// `__Host-csrf` check. The link's token arrives with the new password, and this request
// does everything on the server (src/lib/auth/recovery.ts, "The token never becomes a
// browser session"):
//
//   1. check the token's shape and the password (12 to 128 characters, typed twice);
//   2. count the attempt (per IP address; fail closed);
//   3. verify the token with Supabase, which opens a recovery session in this request's
//      own client and spends the token;
//   4. set the password with that session;
//   5. sign the account out everywhere (every refresh token revoked, the recovery one
//      included), and clear any session cookie this browser holds;
//   6. audit it against the account, with the service role.
//
// Then the person signs in with the new password. Steps 1 and 2 keep the token unspent,
// so the page shows the form again. After step 3 the token is spent: if Supabase then
// refuses the password (its own policy, or the same password as before), the recovery
// session is signed out and the person needs a new link.
//
// Answers: JSON for a script (200, 400, 422, 429, 503), a 303 for the page's form: to
// /admin/login?reset=done, or back to /admin/reset with an `error` code (and the token,
// while it is still unspent).

export const prerender = false;

const RESET_PAGE = '/admin/reset';

type Failure =
  | 'invalid-link'
  | 'length'
  | 'mismatch'
  | 'limited'
  | 'unavailable'
  | 'refused'
  | 'interrupted';

const FAILURE_STATUS: Record<Failure, number> = {
  'invalid-link': 400,
  length: 422,
  mismatch: 422,
  limited: 429,
  unavailable: 503,
  refused: 422,
  interrupted: 503,
};

/** The page codes. A failure before the token is spent keeps it in the URL. */
const PAGE_CODE: Record<Failure, string> = {
  'invalid-link': 'expired',
  length: 'length',
  mismatch: 'mismatch',
  limited: 'limited',
  unavailable: 'unavailable',
  refused: 'refused',
  interrupted: 'interrupted',
};
const TOKEN_KEPT: ReadonlySet<Failure> = new Set(['length', 'mismatch', 'limited', 'unavailable']);

export const POST: APIRoute = async ({ request, cookies }) => {
  const body = await readAuthBody(request);
  if (!body) return json({ ok: false, error: 'bad-request' }, 400);

  const rawToken = body.fields['token_hash'] ?? body.fields['token'];
  const token =
    typeof rawToken === 'string' && RECOVERY_TOKEN_PATTERN.test(rawToken) ? rawToken : null;

  const fail = (failure: Failure): Response => {
    if (body.kind === 'json') return json({ ok: false, error: failure }, FAILURE_STATUS[failure]);
    const params = new URLSearchParams();
    if (token && TOKEN_KEPT.has(failure)) {
      params.set('token_hash', token);
      params.set('type', 'recovery');
    }
    params.set('error', PAGE_CODE[failure]);
    return seeOther(`${RESET_PAGE}?${params}`);
  };

  if (!token) return fail('invalid-link');
  const password = body.fields['password'];
  if (
    typeof password !== 'string' ||
    password.length < NEW_PASSWORD_MIN ||
    password.length > NEW_PASSWORD_MAX
  ) {
    return fail('length');
  }
  const parsed = ResetPasswordSchema.safeParse({
    token,
    password,
    confirm: body.fields['confirm'],
  });
  if (!parsed.success) return fail('mismatch');

  const ip = clientIp(request);
  const launchTenant = await resolveLaunchTenantId();
  if (!launchTenant) return fail('unavailable');
  const limited = await checkRecoveryLimits(launchTenant, resetLimitRules(ip));
  if (limited !== 'ok') return fail(limited === 'limited' ? 'limited' : 'unavailable');

  const client = recoveryClient();
  let userId: string;
  try {
    const { data, error } = await client.auth.verifyOtp({
      type: 'recovery',
      token_hash: parsed.data.token,
    });
    // GoTrue's own throttle or outage leaves the token unspent: say so, and keep it.
    if (error?.status === 429) return fail('limited');
    if (error && (error.status ?? 0) >= 500) return fail('unavailable');
    if (error || !data.session || !data.user) return fail('invalid-link');
    userId = data.user.id;
  } catch {
    return fail('unavailable');
  }

  try {
    const { error } = await client.auth.updateUser({ password: parsed.data.password });
    if (error) {
      // The token is spent: end the recovery session it opened, so nothing outlives the
      // request, and say plainly that a new link is needed. A 4xx is GoTrue refusing the
      // password (its policy, or the same as before); anything else broke on the way.
      await client.auth.signOut({ scope: 'local' }).catch(() => undefined);
      const status = error.status ?? 0;
      return fail(status >= 400 && status < 500 && status !== 429 ? 'refused' : 'interrupted');
    }
  } catch {
    await client.auth.signOut({ scope: 'local' }).catch(() => undefined);
    return fail('interrupted');
  }

  // Everywhere: every session of the account, on every device, the recovery one included.
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
      source: 'auth.reset',
      message: 'A password was reset but its other sessions could not be signed out',
      detail: { userId },
    });
  }

  const profile = await profileOf(userId);
  await writeAuthAudit({
    tenantId: profile?.tenantId ?? launchTenant,
    actorId: userId,
    actorRole: profile?.role ?? null,
    action: 'auth.password_reset',
    entityType: 'profile',
    entityId: userId,
    detail: { ip: ip ?? null, signedOutEverywhere },
  });

  return body.kind === 'json'
    ? json({ ok: true, data: { signedOutEverywhere } })
    : seeOther('/admin/login?reset=done');
};
