import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from './types';
import { isRole } from './types';
import { accessClaims, signedInAt } from './claims';
import { factorsOf, secondStepNeeded, type FactorLike, type PendingSecondStep } from './twoStep';
import { serviceClient } from '@/lib/supabase/server';
import { writeSystemLog } from '@/lib/data/systemLog';
import {
  AMR_MISSING,
  PROFILE_ONLY,
  PROFILE_WITH_SETTING,
  SESSION_LOG_SOURCE,
  SETTING_MISSHAPEN,
  SETTING_UNREADABLE,
} from './sessionSetting';

// Resolves the verified auth context for a request, or null (→ deny).
//
// Four facts have to agree before a request is treated as authenticated:
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
//   4. The sign-in is at the level the account requires (Admin v2 U17, src/lib/auth/twoStep.ts):
//      a person with a verified factor, or in a tenant that requires 2FA, must be at `aal2`.
//      Below it the request gets NO context, only a PENDING second step (`challenge` when a
//      verified factor exists, `enrol` when the tenant requires one and there is none), which
//      the middleware lets reach /admin/2fa and sign-out and nothing else. It is neither
//      downgraded nor accepted (CLAUDE.md §2, session invalidation). Its token usually carries
//      no role at all (the access-token hook withholds it below the required level, 0072), so
//      the profile is read for it too; a token that still carries one (minted before the
//      factor or the tenant's switch) is held at the second step the same way, and the hook
//      strips it at the next refresh. A person who needs no second step sees no change.
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
// Rollback: revert this file to its pre-U17 version (git history; docs/admin-v2/as-built/U17.md
// says what goes with it), or to its pre-U12a version, which needs nothing from the database
// that 0050 did not already have (docs/admin-v2/as-built/U12a.md).

export interface ResolveResult {
  ctx: AuthContext | null;
  /** Set when a session existed but must be torn down (stale role/tenant, lockout, age). */
  revoke: boolean;
  /** A session that passed the password but must still type a code or set 2FA up (U17). */
  pending: PendingSecondStep | null;
}

/** Active, unlocked, with a role and a tenant: the profile a session may stand on, or not. */
type ProfileVerdict = { ok: true; role: AuthContext['role']; tenantId: string } | { ok: false };

interface ProfileRow {
  tenant_id: unknown;
  role: unknown;
  is_active: unknown;
  locked_until: unknown;
  tenant?: unknown;
}

const DENY_ANON: ResolveResult = { ctx: null, revoke: false, pending: null };
const DENY_REVOKE: ResolveResult = { ctx: null, revoke: true, pending: null };

/** How far apart this Worker's clock and the auth server's may be: five minutes. */
export const CLOCK_SKEW_SECONDS = 300;

/** The session length when the tenant has not chosen one: the session cookie's 7 days. */
export const DEFAULT_SESSION_MAX_DAYS = 7;

const DAY_SECONDS = 86_400;

// The select and the log messages: src/lib/auth/sessionSetting.ts (shared with the e2e).
export { PROFILE_WITH_SETTING, SETTING_UNREADABLE, SETTING_MISSHAPEN, AMR_MISSING };

/** What has been logged in this isolate already (each once: a log per request is noise). */
const loggedOnce = new Set<string>();

/** For tests: forget what this isolate has logged. */
export function resetAuthContextLogs(): void {
  loggedOnce.clear();
}

async function logOnce(key: string, level: 'warn' | 'error', message: string): Promise<void> {
  if (loggedOnce.has(key)) return;
  loggedOnce.add(key);
  // Workers Logs too, so the line is seen even if the system_logs insert fails.
  console.error(`${SESSION_LOG_SOURCE} ${message}`);
  // Never throws (src/lib/data/systemLog.ts). No detail: nothing about the person.
  await writeSystemLog({ level, source: SESSION_LOG_SOURCE, message });
}

/**
 * Whether the embed came back in the shape the select asks for: a `tenant` object holding a
 * `security` key (null when the tenant has not saved its settings). Anything else means the
 * relationship was not resolved as written, and the session length would silently default.
 */
export function embedShapeOk(row: { tenant?: unknown }): boolean {
  const tenant = one(row.tenant);
  return tenant !== null && 'security' in tenant;
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

/**
 * Whether the tenant requires 2FA (0072), from the embedded setting: true only for a literal
 * `true`. Anything else (no row, the plain-profile fallback, a misshapen embed, which is logged
 * once with the session length's) is "not required" at the Worker; the access-token hook still
 * holds the database layer.
 */
export function tenantRequiresMfa(profile: { tenant?: unknown }): boolean {
  return one(one(profile.tenant)?.['security'])?.['require_mfa'] === true;
}

function profileVerdict(profile: ProfileRow, now: number): ProfileVerdict {
  const { tenant_id: tenant, role, is_active: isActive, locked_until: lockedUntil } = profile;
  if (isActive !== true) return { ok: false };
  if (typeof lockedUntil === 'string' && Date.parse(lockedUntil) > now) return { ok: false };
  if (!isRole(role) || typeof tenant !== 'string') return { ok: false };
  return { ok: true, role, tenantId: tenant };
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
    if (!error) {
      if (data && !embedShapeOk(data))
        await logOnce('setting-misshapen', 'error', SETTING_MISSHAPEN);
      return data ?? null;
    }
  } catch {
    // Fall through to the plain read: an embed problem must not sign anyone out.
  }
  // An error, not a warning: the tenant's session length is not being enforced.
  await logOnce('setting-unreadable', 'error', SETTING_UNREADABLE);
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
  let factors: readonly FactorLike[] | null;

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
    // The account's factors as the auth server holds them now (U17): what fact 4 reads.
    factors = (data.user.factors as readonly FactorLike[] | undefined) ?? null;
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

  const factor = factorsOf(factors);

  /** Fact 3. A token with no sign-in time is let through without an age check, never refused. */
  const tooOld = async (profile: ProfileRow): Promise<boolean> => {
    const signedIn = signedInAt(claims);
    if (signedIn === null) {
      await logOnce('amr-missing', 'warn', AMR_MISSING);
      return false;
    }
    return nowSeconds - signedIn > sessionMaxDays(profile) * DAY_SECONDS + CLOCK_SKEW_SECONDS;
  };

  /** Fact 4: the second step this session still owes, or null (src/lib/auth/twoStep.ts). */
  const owed = (profile: ProfileRow) =>
    secondStepNeeded({
      verifiedFactor: factor.verified,
      tenantRequires: tenantRequiresMfa(profile),
      aal: claims.aal,
    });

  const held = (
    verdict: { role: AuthContext['role']; tenantId: string },
    mode: 'challenge' | 'enrol',
  ): ResolveResult => ({
    ctx: null,
    revoke: false,
    pending: {
      userId,
      tenantId: verdict.tenantId,
      email,
      role: verdict.role,
      mode,
      factorId: factor.totpId,
    },
  });

  // app_metadata ONLY (never user_metadata, which the user can write), and the TOKEN's: the
  // role RLS will enforce for this request's queries.
  const jwtRole = claims.role;
  const jwtTenant = claims.tenantId;
  // A session with no role/tenant claim never had access to begin with: the access-token
  // hook did not stamp it (no profile, a switched-off one, or since 0072 a sign-in below the
  // level the account requires), so RLS would resolve this user into the anon fence. Only
  // the last becomes a pending second step; everything else is anonymous, as before U17.
  if (!isRole(jwtRole) || typeof jwtTenant !== 'string' || jwtTenant.length === 0) {
    // An aal2 token the hook did not stamp is owed no code: anonymous, without a read.
    if (claims.aal === 'aal2') return DENY_ANON;
    let profile: ProfileRow | null;
    try {
      profile = await readProfile(userId);
    } catch {
      // Not the refusal of a session that had access: it never had any. As before U17.
      return DENY_ANON;
    }
    if (!profile) return DENY_ANON;
    const mode = owed(profile);
    if (mode === null) return DENY_ANON;
    // From here the session is a sign-in in progress: a profile that cannot stand (switched
    // off, or locked, as the fifth wrong code does) ends it, as it ends a full session.
    const verdict = profileVerdict(profile, now);
    if (!verdict.ok) return DENY_REVOKE;
    if (await tooOld(profile)) return DENY_REVOKE;
    return held(verdict, mode);
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

  const verdict = profileVerdict(profile, now);
  if (!verdict.ok) return DENY_REVOKE;

  // See the header comment: stale claims cannot be downgraded, only rejected.
  if (verdict.role !== jwtRole || verdict.tenantId !== jwtTenant) return DENY_REVOKE;

  if (await tooOld(profile)) return DENY_REVOKE;

  // Fact 4. A token minted before the factor was verified, or before the tenant switched
  // Require on, still carries its role: it is held at the second step all the same.
  const mode = owed(profile);
  if (mode !== null) return held(verdict, mode);

  return {
    ctx: {
      userId,
      tenantId: verdict.tenantId,
      role: verdict.role,
      isActive: true,
      email,
      twoStep: {
        on: factor.verified,
        required: tenantRequiresMfa(profile),
        factorId: factor.totpId,
      },
    },
    revoke: false,
    pending: null,
  };
}
