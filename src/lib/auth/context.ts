import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from './types';
import { isRole } from './types';
import { accessClaims, signedInAt } from './claims';
import { serviceClient } from '@/lib/supabase/server';
import { writeSystemLog } from '@/lib/data/systemLog';

// Resolves the verified auth context for a request, or null (→ deny).
//
// Three facts have to agree before a request is treated as authenticated:
//
//   1. The token is genuine and its session alive. `getUser(token)` asks the auth server,
//      which checks the signature and that the session the token names still exists (a
//      revoked session answers session_not_found). Never `getSession()` ALONE: it returns
//      whatever is in the cookie WITHOUT verifying it. Here it only hands over the token
//      (refreshing it first when it is about to expire, as getUser() would itself), and
//      the token it hands over is the one the auth server then verifies.
//
//   2. The profile row still says so, as the TOKEN says it. Roles live in the token (that
//      is what RLS reads), and a token stays valid until it expires, up to an hour. So the
//      profile (role, is_active, locked_until, tenant) is read on every admin request and
//      compared with the claims of the very token this request carries (Admin v2 U12a).
//      Before U12a this compared the profile with getUser()'s user record, the account's
//      CURRENT app_metadata, which the users screen rewrites with the profile: the two
//      always agreed, so a stale token was never seen (CLAUDE.md §2, session invalidation).
//
//   3. The sign-in is young enough: no older than the tenant's session length
//      (admin_security_settings.session_max_days, 1 or 7 days, 7 when unset), counted from
//      the newest sign-in time the token's `amr` records.
//
// ── Why divergence DENIES instead of downgrading ─────────────────────────────────
// The obvious move when the token says `admin` and the row says `seo` is "use the row" —
// and for assertCap() that is right. But it is not sufficient, because assertCap() is
// the SECONDARY layer: Postgres RLS, the primary one, reads app_metadata.role out of
// the token and would still be enforcing `admin` for every query this request makes.
// Downgrading only the layer that reads the database would leave the demoted user with
// full admin rights at the layer that matters most. So divergence invalidates the
// session outright (the middleware signs it out and clears the cookies); the next sign-in
// mints a token both layers agree on. The database half of "force-revoke sessions on
// role/tenant change" is profiles_revoke_sessions (0055): it deletes the person's
// sessions, so step 1 already refuses them; this comparison is the second layer.
//
// ── Never signing a valid session out by mistake ─────────────────────────────────
// A bug here refuses every member on every request, the owner included. So:
//   • only `sub` and `exp` of the claims are required (src/lib/auth/claims.ts);
//   • `exp` and the session age allow CLOCK_SKEW_SECONDS of difference between this
//     Worker's clock and the auth server's;
//   • a token with no sign-in time in `amr` is let through without an age check (logged
//     once per isolate), never refused: a change in what GoTrue writes must not sign
//     everyone out;
//   • the tenant's setting is read in the profile's own request. If that read fails
//     (0055 not applied yet, a stale schema cache), the profile is read again alone and
//     the 7-day default applies, logged once per isolate. Only an unreadable PROFILE
//     fails closed, as it always has.
// Rollback: revert this file to its pre-U12a version (git history); it needs nothing
// from the database that 0050 did not already have (docs/admin-v2/as-built/U12a.md).

export interface ResolveResult {
  ctx: AuthContext | null;
  /** Set when a session existed but must be torn down (stale role/tenant, lockout, age). */
  revoke: boolean;
}

interface ProfileRow {
  tenant_id: unknown;
  role: unknown;
  is_active: unknown;
  locked_until: unknown;
  tenant?: unknown;
}

const DENY_ANON: ResolveResult = { ctx: null, revoke: false };
const DENY_REVOKE: ResolveResult = { ctx: null, revoke: true };

/** How far apart this Worker's clock and the auth server's may be: five minutes. */
export const CLOCK_SKEW_SECONDS = 300;

/** The session length when the tenant has not chosen one: the session cookie's 7 days. */
export const DEFAULT_SESSION_MAX_DAYS = 7;

const DAY_SECONDS = 86_400;

/** The profile and, in the same request, the tenant's session length (0055). */
const PROFILE_WITH_SETTING =
  'tenant_id,role,is_active,locked_until,tenant:tenants(security:admin_security_settings(session_max_days))';
const PROFILE_ONLY = 'tenant_id,role,is_active,locked_until';

/** What has been logged in this isolate already (each once: a log per request is noise). */
const loggedOnce = new Set<string>();

/** For tests: forget what this isolate has logged. */
export function resetAuthContextLogs(): void {
  loggedOnce.clear();
}

async function logOnce(key: string, message: string): Promise<void> {
  if (loggedOnce.has(key)) return;
  loggedOnce.add(key);
  // Never throws (src/lib/data/systemLog.ts). No detail: nothing about the person.
  await writeSystemLog({ level: 'warn', source: 'auth:session', message });
}

/** A to-one embed as PostgREST answers it: an object, or a one-row array on older servers. */
function one(value: unknown): Record<string, unknown> | null {
  const row = Array.isArray(value) ? value[0] : value;
  return row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : null;
}

/**
 * The tenant's session length in days, from the embedded setting: 1 to 7 as stored, and the
 * 7-day default for a missing row or anything the column could not hold.
 */
export function sessionMaxDays(profile: { tenant?: unknown }): number {
  const days = one(one(profile.tenant)?.['security'])?.['session_max_days'];
  return typeof days === 'number' && Number.isInteger(days) && days >= 1 && days <= 7
    ? days
    : DEFAULT_SESSION_MAX_DAYS;
}

/** The profile with the setting; the profile alone when the embed is refused; null = unreadable. */
async function readProfile(userId: string): Promise<ProfileRow | null> {
  const sb = serviceClient();
  try {
    const { data, error } = await sb
      .from('profiles')
      .select(PROFILE_WITH_SETTING)
      .eq('id', userId)
      .maybeSingle<ProfileRow>();
    if (!error) return data ?? null;
  } catch {
    // Fall through to the plain read: an embed problem must not sign anyone out.
  }
  await logOnce(
    'setting-unreadable',
    'session length unreadable with the profile; the 7-day default applies',
  );
  const { data, error } = await sb
    .from('profiles')
    .select(PROFILE_ONLY)
    .eq('id', userId)
    .maybeSingle<ProfileRow>();
  if (error) throw new Error(error.message);
  return data ?? null;
}

export async function resolveAuthContext(
  supabase: SupabaseClient,
  now: number = Date.now(),
): Promise<ResolveResult> {
  let userId: string;
  let email: string;
  let token: string;

  try {
    // The token this request carries (refreshed first when it is about to expire), then
    // the auth server's word on exactly that token. supabase-js's own getClaims() does the
    // same two steps for a project on symmetric keys.
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0) return DENY_ANON;
    const { data, error } = await supabase.auth.getUser(accessToken);
    if (error || !data.user) return DENY_ANON;
    userId = data.user.id;
    email = data.user.email ?? '';
    token = accessToken;
  } catch {
    return DENY_ANON;
  }

  // Safe without a second signature check: getUser() has just verified this same token at
  // the auth server, in this request. It is decoded only for its claims.
  const claims = accessClaims(token);
  const nowSeconds = Math.floor(now / 1000);
  if (!claims || claims.sub !== userId || claims.exp + CLOCK_SKEW_SECONDS <= nowSeconds) {
    return DENY_REVOKE;
  }

  // app_metadata ONLY (never user_metadata, which the user can write), and the TOKEN's: the
  // role RLS will enforce for this request's queries.
  const jwtRole = claims.role;
  const jwtTenant = claims.tenantId;
  // A session with no role/tenant claim never had access to begin with: the access-token
  // hook did not stamp it (no profile, or a switched-off one), so RLS would resolve this
  // user into the anon fence. Anonymous rather than half-authenticated.
  if (!isRole(jwtRole) || typeof jwtTenant !== 'string' || jwtTenant.length === 0) {
    return DENY_ANON;
  }

  let profile: ProfileRow | null;
  try {
    profile = await readProfile(userId);
  } catch {
    // A failed live-recheck is a DENY, not a pass. Falling back to the token here would
    // mean a database outage silently re-enables every account we just disabled.
    return DENY_REVOKE;
  }
  if (!profile) return DENY_REVOKE;

  const {
    tenant_id: dbTenant,
    role: dbRole,
    is_active: isActive,
    locked_until: lockedUntil,
  } = profile;

  if (isActive !== true) return DENY_REVOKE;
  if (typeof lockedUntil === 'string' && Date.parse(lockedUntil) > now) return DENY_REVOKE;
  if (!isRole(dbRole) || typeof dbTenant !== 'string') return DENY_REVOKE;

  // See the header comment: stale claims cannot be downgraded, only rejected.
  if (dbRole !== jwtRole || dbTenant !== jwtTenant) return DENY_REVOKE;

  // The session length. No sign-in time in the token: let through, never refused.
  const signedIn = signedInAt(claims);
  if (signedIn === null) {
    await logOnce('amr-missing', 'access token without a sign-in time; session age not checked');
  } else if (nowSeconds - signedIn > sessionMaxDays(profile) * DAY_SECONDS + CLOCK_SKEW_SECONDS) {
    return DENY_REVOKE;
  }

  return {
    ctx: { userId, tenantId: dbTenant, role: dbRole, isActive: true, email },
    revoke: false,
  };
}
