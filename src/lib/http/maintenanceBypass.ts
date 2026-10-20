import type { AstroCookies } from 'astro';
import { accessClaims } from '@/lib/auth/claims';
import { resolveAuthContext } from '@/lib/auth/context';
import { createSessionClient, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { isRole } from '@/lib/auth/types';

// The staff bypass of maintenance mode (Admin v2 U9b, decision D15): when the switch allows it
// ("Signed in team still sees the site", the KV value's `staffBypass`), a request carrying a
// session that passes the SAME check the admin applies (src/lib/auth/context.ts: the token's
// signature and live session at the auth server, the profile active, unlocked, of the token's
// role and tenant, the session's age, and since U17 the second step) sees the real site.
//
// FAIL CLOSED, every way: no session cookie, a cookie that is not a session, a token past its
// expiry or with no member role, an auth server or profile read that fails or takes longer
// than 1.5 s, a session the check revokes or holds at its second step: each is no bypass, so
// the visitor's 503. Only a context the check returns whole lets the request through.
//
// No side effects on a public path: it never signs anyone out and never clears a cookie (the
// admin does that on its own next request). The session client may refresh an access token
// about to expire and write the new cookies onto this response; that response is a bypassed
// one, `private, no-store` (src/middleware.ts), so nothing caches them.
//
// Cost (owner item O-16): a request with a session-looking cookie during maintenance asks the
// auth server once and reads the profile once. The local pre-filter below never grants; it
// keeps garbage, expired or role-less cookies from costing those two subrequests.

/** How long the check may take before the request gets the 503. */
export const BYPASS_TIMEOUT_MS = 1_500;

/** @supabase/ssr's chunk count (src/lib/auth/session.ts reads the same eight). */
const CHUNKS = 8;

/** The session cookie's value, joined from its chunks, or null. */
function sessionCookieValue(cookies: AstroCookies): string | null {
  const whole = cookies.get(SESSION_COOKIE_NAME)?.value;
  if (whole) return whole;
  let joined = '';
  for (let i = 0; i < CHUNKS; i += 1) {
    const part = cookies.get(`${SESSION_COOKIE_NAME}.${i}`)?.value;
    if (!part) break;
    joined += part;
  }
  return joined || null;
}

/** The access token a stored session carries, decoded without trusting it; null otherwise. */
export function storedAccessToken(value: string): string | null {
  try {
    let json = value;
    if (value.startsWith('base64-')) {
      const b64 = value.slice('base64-'.length).replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
      const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
      json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    const parsed = JSON.parse(json) as unknown;
    const token =
      parsed && typeof parsed === 'object' ? (parsed as { access_token?: unknown }).access_token : null;
    return typeof token === 'string' && token.length > 0 && token.length < 16_384 ? token : null;
  } catch {
    return null;
  }
}

/**
 * The local pre-filter: a cookie worth asking the auth server about. It NEVER grants: a true
 * here only lets the real check run. False for no cookie, an unreadable one, an expired token
 * or one with no member role.
 */
export function worthChecking(cookies: AstroCookies, now: number = Date.now()): boolean {
  const value = sessionCookieValue(cookies);
  if (!value || value.length > 32_768) return false;
  const token = storedAccessToken(value);
  if (!token) return false;
  const claims = accessClaims(token);
  if (!claims) return false;
  if (claims.exp * 1000 <= now) return false;
  return isRole(claims.role);
}

export interface BypassDeps {
  /** Seams for tests: the session client and the check, as the admin builds them. */
  createClient?: typeof createSessionClient;
  resolve?: typeof resolveAuthContext;
  timeoutMs?: number;
  now?: number;
}

/**
 * Whether this request's signed-in person may see the site past the maintenance page. False
 * unless the admin's own session check passes, in time (see the header).
 */
export async function staffMayBypass(
  cookies: AstroCookies,
  deps: BypassDeps = {},
): Promise<boolean> {
  try {
    if (!worthChecking(cookies, deps.now)) return false;
    const supabase = (deps.createClient ?? createSessionClient)(cookies);
    const check = (deps.resolve ?? resolveAuthContext)(supabase).then(
      (result) => result.ctx !== null && !result.revoke,
      () => false,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), deps.timeoutMs ?? BYPASS_TIMEOUT_MS);
    });
    try {
      return await Promise.race([check, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } catch {
    return false;
  }
}
