// The session check's contract with the database and its alerts (Admin v2 U12a), in a module
// with no imports, so the e2e suite (tests/admin/users.e2e.ts) can run the same select through
// the local PostgREST and look for the same system_logs messages. src/lib/auth/context.ts uses
// them.

/**
 * The profile and, in the same request, the tenant's session length (0055) and whether it
 * requires 2FA (0072, Admin v2 U17).
 */
export const PROFILE_WITH_SETTING =
  'tenant_id,role,is_active,locked_until,tenant:tenants(security:admin_security_settings(session_max_days,require_mfa))';

/** The profile alone: the fallback when the embed is refused. */
export const PROFILE_ONLY = 'tenant_id,role,is_active,locked_until';

/** system_logs `source` of the session check's own lines. */
export const SESSION_LOG_SOURCE = 'auth:session';

/** Errors: the tenant's session length is not being enforced (the 7-day default applies). */
export const SETTING_UNREADABLE =
  'session length unreadable with the profile; the 7-day default applies';
export const SETTING_MISSHAPEN =
  'session length embed answered without the tenant or its security key; the 7-day default applies';

/** A warning: a token with no sign-in time was let through without an age check. */
export const AMR_MISSING = 'access token without a sign-in time; session age not checked';
