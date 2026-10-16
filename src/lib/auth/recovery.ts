import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { PUBLIC_SITE_URL, PUBLIC_SUPABASE_ANON_KEY, PUBLIC_SUPABASE_URL } from 'astro:env/client';
import { AUTH_EMAIL_READY, LEAD_PII_ENC_KEY } from 'astro:env/server';
import { serviceClient } from '@/lib/supabase/server';
import { writeSystemLog } from '@/lib/data/systemLog';
import {
  checkPublicLimits,
  ipLimitValue,
  type LimitOutcome,
  type PublicLimitRule,
} from '@/lib/http/publicRateLimit';

// Forgot and reset password (Admin v2 F7, docs/admin-v2/ui.md AV-06): the server side the
// two endpoints share.
//
// ── The token never becomes a browser session ────────────────────────────────────
// Supabase's reset e-mail carries a one-time recovery token. The reset page posts it with
// the new password, and the endpoint, on the server, in ONE request: verifies it (which
// opens a recovery session), sets the password with that session, signs the account out
// everywhere, and forgets the session. It lives only in a client made for that request
// (recoveryClient: no persistence, no cookie), so no recovery session ever reaches a
// cookie: it could otherwise open the admin to whoever holds the link, password unset.
// The page does not verify the token on GET either: mail scanners fetch links, and a GET
// that spent the token would leave the person with a dead link.
//
// ── E-mail delivery is an owner item (O-2) ──────────────────────────────────────
// Supabase sends the e-mail. Until SMTP and the recovery template are set up in its
// dashboard (docs/launch-runbook.md §2b), AUTH_EMAIL_READY stays false and the forgot
// screen says "Not set up" instead of pretending; the reset side works either way, since
// its token can come only from a real e-mail (or, in the e2e harness, the admin API).

export function authEmailReady(): boolean {
  return AUTH_EMAIL_READY === true;
}

/**
 * The limits (EXC-004's Postgres counter, src/lib/http/publicRateLimit.ts, under its own
 * scopes). Per address and per e-mail as the design asks; the tenant-wide cap bounds what
 * a crowd of addresses can make the endpoint do (each accepted request is a GoTrue call,
 * maybe an e-mail, and a hash-chained audit row). Both endpoints fail CLOSED.
 */
export const RECOVERY_LIMITS = {
  forgotPerIp: { max: 5, windowSeconds: 3600 },
  forgotPerEmail: { max: 3, windowSeconds: 3600 },
  forgotPerTenant: { max: 50, windowSeconds: 3600 },
  resetPerIp: { max: 10, windowSeconds: 3600 },
  // Accepting an invite (Admin v2 U12b): reset's per-address window, and a tenant-wide one
  // counted only for a request the first let through (as forgot's), which bounds what a
  // crowd of addresses can make the endpoint do (a GoTrue verify each).
  invitePerIp: { max: 10, windowSeconds: 3600 },
  invitePerTenant: { max: 30, windowSeconds: 3600 },
} as const;

/**
 * The forgot rules for one request, in two groups: the caller's own (per address, and per
 * e-mail when it is one) and the tenant's (one window everyone shares). checkForgotLimits
 * counts the second only for a request the first let through.
 */
export function forgotLimitRules(
  ip: string | null,
  email: string | null,
): { caller: PublicLimitRule[]; tenant: PublicLimitRule } {
  return {
    caller: [
      { scope: 'auth.forgot:ip', value: ipLimitValue(ip), ...RECOVERY_LIMITS.forgotPerIp },
      ...(email
        ? [{ scope: 'auth.forgot:email', value: email, ...RECOVERY_LIMITS.forgotPerEmail }]
        : []),
    ],
    tenant: { scope: 'auth.forgot:tenant', value: 'all', ...RECOVERY_LIMITS.forgotPerTenant },
  };
}

export function resetLimitRules(ip: string | null): PublicLimitRule[] {
  return [{ scope: 'auth.reset:ip', value: ipLimitValue(ip), ...RECOVERY_LIMITS.resetPerIp }];
}

/** The invite acceptance's rules: the caller's address, and the tenant's one window. */
export function inviteLimitRules(ip: string | null): {
  caller: PublicLimitRule[];
  tenant: PublicLimitRule;
} {
  return {
    caller: [{ scope: 'auth.invite:ip', value: ipLimitValue(ip), ...RECOVERY_LIMITS.invitePerIp }],
    tenant: { scope: 'auth.invite:tenant', value: 'all', ...RECOVERY_LIMITS.invitePerTenant },
  };
}

/** Counts one attempt (service role; the key is a labelled HMAC, never the raw value). */
export function checkRecoveryLimits(
  tenantId: string,
  rules: readonly PublicLimitRule[],
): Promise<LimitOutcome> {
  return checkPublicLimits(serviceClient(), tenantId, LEAD_PII_ENC_KEY, rules);
}

/**
 * The forgot limits for one request. The caller's own windows first, every one of them
 * counted (checkPublicLimits: an address rotating through IPs still fills the per-e-mail
 * window). The tenant's window only when those let the request through: a request one
 * address's limit has already refused costs nothing (no GoTrue call, no e-mail, no audit
 * row), so it must not spend the cap everyone shares. Counted with the rest, it did: one
 * machine sending 50 requests an hour (5 accepted, 45 refused) closed "Forgot password?"
 * for every staff member until the window turned (F7 review).
 *
 * What remains, by design: many addresses (each IPv6 /64 is one) can still spend the
 * tenant's cap, which is the cap's job (it bounds the e-mails and audit rows a crowd can
 * cause); and anyone can spend one address's per-e-mail window with 3 requests, which
 * holds back that person's resets for the hour, never their sign-in.
 */
export async function checkForgotLimits(
  tenantId: string,
  ip: string | null,
  email: string | null,
): Promise<LimitOutcome> {
  const { caller, tenant } = forgotLimitRules(ip, email);
  const own = await checkRecoveryLimits(tenantId, caller);
  if (own !== 'ok') return own;
  return checkRecoveryLimits(tenantId, [tenant]);
}

/**
 * The invite acceptance's limits, as checkForgotLimits counts its own: the address first, the
 * tenant's window only for a request the address's limit let through. Both fail CLOSED.
 */
export async function checkInviteLimits(
  tenantId: string,
  ip: string | null,
): Promise<LimitOutcome> {
  const { caller, tenant } = inviteLimitRules(ip);
  const own = await checkRecoveryLimits(tenantId, caller);
  if (own !== 'ok') return own;
  return checkRecoveryLimits(tenantId, [tenant]);
}

/**
 * A Supabase client for ONE recovery request: the anon key, no persistence, no refresh,
 * the implicit flow (a PKCE verifier would need a cookie, and the e-mail's token_hash link
 * needs none). Never shared: the session a verified token opens lives in this object's
 * memory, so a module-level client would hand one person's recovery session to the next
 * request in the same isolate.
 */
export function recoveryClient(): SupabaseClient {
  return createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      flowType: 'implicit',
    },
  });
}

/** Where the e-mail's link lands: the configured origin, never the request's Host. */
export function resetPageUrl(): string {
  return new URL('/admin/reset', PUBLIC_SITE_URL).toString();
}

/** Where an invite e-mail's link lands (Admin v2 U12b): the configured origin, likewise. */
export function invitePageUrl(): string {
  return new URL('/admin/invite', PUBLIC_SITE_URL).toString();
}

/**
 * Asks Supabase to e-mail a reset link. Never throws and never tells the caller what
 * happened: an unknown address, a per-user throttle and an SMTP failure must all look
 * like success to whoever asked, so the endpoint runs this after it has answered
 * (waitUntil). A failure goes to system_logs with its status, never the address: the
 * generic answer hides delivery failures, so this is where an operator finds them.
 */
export async function sendResetEmail(email: string): Promise<void> {
  try {
    const { error } = await recoveryClient().auth.resetPasswordForEmail(email, {
      redirectTo: resetPageUrl(),
    });
    if (error) {
      await writeSystemLog({
        level: 'warn',
        source: 'auth.forgot',
        message: 'A password reset e-mail was not sent',
        detail: { status: error.status ?? null, code: error.code ?? null },
      });
    }
  } catch (err) {
    await writeSystemLog({
      level: 'warn',
      source: 'auth.forgot',
      message: 'A password reset e-mail was not sent',
      detail: { thrown: err instanceof Error ? err.name : 'unknown' },
    });
  }
}

export interface AuthAuditRow {
  tenantId: string;
  /** The account the event is about, when there is one (a reset); null for a request. */
  actorId: string | null;
  actorRole: string | null;
  action: 'auth.password_reset_requested' | 'auth.password_reset' | 'auth.invite_accepted';
  entityType: string;
  entityId: string | null;
  detail: Record<string, unknown>;
}

/**
 * Writes one audit row with the service role. These events have no staff session to
 * write under (a forgot request is anonymous; a reset's only session is the recovery one,
 * which is never trusted with a write), so the row is the service role's, with the tenant
 * resolved on the server (the anon fence). The chain trigger hashes it like any other row
 * (CLAUDE.md §9 (h): a service-role insert is still chained). Never throws; a failure is
 * reported to system_logs, as writeAudit reports one (src/lib/admin/audit.ts).
 */
export async function writeAuthAudit(row: AuthAuditRow): Promise<boolean> {
  const report = async (detail: Record<string, unknown>): Promise<false> => {
    await writeSystemLog({
      level: 'error',
      source: 'audit',
      message: `audit_log write failed for action "${row.action}"`,
      detail: { action: row.action, ...detail },
    });
    return false;
  };
  try {
    const { error } = await serviceClient().from('audit_log').insert({
      tenant_id: row.tenantId,
      actor_id: row.actorId,
      actor_role: row.actorRole,
      action: row.action,
      entity_type: row.entityType,
      entity_id: row.entityId,
      detail: row.detail,
    });
    if (error) return await report({ code: error.code ?? null, message: error.message });
    return true;
  } catch (err) {
    return await report({ message: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * The account's tenant, role and whether it may sign in, for an accepted invite: a person
 * switched off after the invite went out sets no password (Admin v2 U12b). Null when there
 * is no profile, or it cannot be read.
 */
export async function inviteeOf(
  userId: string,
): Promise<{ tenantId: string; role: string; isActive: boolean } | null> {
  try {
    const { data, error } = await serviceClient()
      .from('profiles')
      .select('tenant_id,role,is_active')
      .eq('id', userId)
      .maybeSingle<{ tenant_id: unknown; role: unknown; is_active: unknown }>();
    if (error || !data) return null;
    const { tenant_id: tenantId, role, is_active: isActive } = data;
    return typeof tenantId === 'string' && typeof role === 'string'
      ? { tenantId, role, isActive: isActive === true }
      : null;
  } catch {
    return null;
  }
}

/** The account's tenant and role, for the reset's audit row. Null when there is no profile. */
export async function profileOf(
  userId: string,
): Promise<{ tenantId: string; role: string } | null> {
  try {
    const { data, error } = await serviceClient()
      .from('profiles')
      .select('tenant_id,role')
      .eq('id', userId)
      .maybeSingle<{ tenant_id: unknown; role: unknown }>();
    if (error || !data) return null;
    const { tenant_id: tenantId, role } = data;
    return typeof tenantId === 'string' && typeof role === 'string' ? { tenantId, role } : null;
  } catch {
    return null;
  }
}

/** Runs work after the response, on the Worker (waitUntil), or detached where there is none. */
export function afterResponse(
  context: { waitUntil?: (promise: Promise<unknown>) => void } | undefined,
  work: Promise<unknown>,
): void {
  const settled = work.catch(() => undefined);
  if (context && typeof context.waitUntil === 'function') context.waitUntil(settled);
}
