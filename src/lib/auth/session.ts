import type { AstroCookies } from 'astro';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from 'astro:env/client';

// Admin session transport (CLAUDE.md Pillar 1 / §7):
//   httpOnly; Secure; SameSite=Lax; Path=/  with the `__Host-` prefix.
//
// Why `__Host-`: the prefix is a browser-enforced contract, not a convention. A cookie
// whose name starts with `__Host-` is REJECTED outright unless it is Secure, Path=/ and
// carries NO Domain attribute — which means a compromised sibling subdomain cannot
// overwrite the admin session cookie (the classic cookie-fixation path that SameSite
// does nothing about). We pay for it with a constraint: it will not be set over plain
// HTTP, so `astro dev` must be reached at http://localhost (a secure context in Chrome
// and Firefox) rather than a LAN IP. The rule binds a DELETION too: a `Set-Cookie` that
// clears a `__Host-` cookie without `Secure` is refused like any other, and the cookie
// stays (clearSessionCookies below).
//
// The client this returns is the ANON-key client carrying the user's JWT, so every
// query it makes runs as `authenticated` and RLS applies as the PRIMARY authz layer.
// The service-role client (src/lib/supabase/server.ts) bypasses RLS and is reserved
// for the few paths that must (login lockout, user administration, exports) — each of
// which pairs it with assertCap() and an explicit tenant predicate.
//
// ── How long a session lasts (Admin v2 F7, "Keep me signed in") ──────────────────
// Ticked (the default, owner item O-14): the cookie carries Max-Age 7 days, written again
// each time the access token refreshes (hourly while the admin is in use), so the browser
// drops it 7 days after the admin was last used. Unticked: a session cookie, with no
// Max-Age, which the browser drops when it closes (a browser that restores its session on
// restart keeps it). The choice is a third `__Host-` cookie (SESSION_ONLY_COOKIE), itself
// a session cookie, because a browser never sends a cookie's attributes back: without it
// a token refresh could not tell which kind of cookie to write.
//
// These are the COOKIE's lifetimes, what an honest browser keeps. The session behind it,
// Supabase's refresh token, is bounded only by Supabase Auth's own session settings (an
// inactivity timeout and a time-box: config.toml [auth.sessions] for the local stack, the
// dashboard for the hosted projects, docs/launch-runbook.md §2b), so a copied cookie value
// works until those end it or a sign-out revokes it.
//
// Before F7 the cookie was meant to last 7 days and lasted 400: @supabase/ssr writes every
// session cookie with ITS default Max-Age (400 days, DEFAULT_COOKIE_OPTIONS), overriding
// the cookieOptions below, and setAll passed that through. Now setAll decides alone.

export const SESSION_COOKIE_NAME = '__Host-braiin-auth';

/** Present (value `1`) while the session was started with "Keep me signed in" unticked. */
export const SESSION_ONLY_COOKIE = '__Host-braiin-session-only';

/** Shared by the session cookie and the CSRF cookie so the attributes cannot drift. */
export const HOST_COOKIE_BASE = {
  path: '/',
  secure: true,
  sameSite: 'lax',
} as const;

/** 7 days: the longest a kept session lasts after its last use. */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

/** @supabase/ssr chunks a large token into `<name>.0`, `<name>.1`, …; 8 ≈ 32 KB. */
const SESSION_CHUNKS = 8;

const SESSION_COOKIE_OPTIONS: CookieOptions = {
  ...HOST_COOKIE_BASE,
  httpOnly: true,
  maxAge: SESSION_MAX_AGE_SECONDS,
};

/**
 * The Max-Age a session cookie is written with. A removal (Max-Age 0, which is how
 * @supabase/ssr deletes a stale chunk or signs out) stays a removal; anything else is our
 * policy, never the library's: 7 days, or no Max-Age at all for a session-only sign-in.
 */
export function sessionCookieMaxAge(
  requested: number | undefined,
  sessionOnly: boolean,
): number | undefined {
  if (requested === 0) return 0;
  return sessionOnly ? undefined : SESSION_MAX_AGE_SECONDS;
}

/**
 * The "Keep me signed in" choice a sign-in in THIS request is making, keyed by the
 * request's cookie jar (one per request: the middleware's and the endpoint's are the same
 * object), true for session-only. It decides the lifetime of the session cookie the
 * sign-in writes, and nothing else, until the sign-in has succeeded
 * (commitSessionPersistence). A WeakMap, so it goes with the request.
 */
const chosenThisRequest = new WeakMap<AstroCookies, boolean>();

/**
 * True while this request's session is session-only: the choice a sign-in in this request
 * made, else the marker the browser sent back (a later request's token refresh).
 */
export function isSessionOnly(cookies: AstroCookies): boolean {
  return chosenThisRequest.get(cookies) ?? cookies.get(SESSION_ONLY_COOKIE)?.value === '1';
}

/**
 * Records the "Keep me signed in" choice for the sign-in about to run. Called BEFORE it,
 * because the sign-in itself writes the session cookie (through setAll below), which reads
 * the choice from here. It writes no cookie: the marker the browser keeps changes only in
 * commitSessionPersistence, once the sign-in has succeeded. A failed attempt (a wrong
 * password typed into a login page left open in another tab, the box at its default) must
 * not change the lifetime of a session already open in this browser, and before the F7
 * review it did: the marker was set or deleted here, and stayed so on the failure path.
 */
export function chooseSessionPersistence(cookies: AstroCookies, remember: boolean): void {
  chosenThisRequest.set(cookies, !remember);
}

/**
 * After a successful sign-in: writes the marker the choice calls for (set for a
 * session-only sign-in, deleted for a kept one), so that a later token refresh writes the
 * same kind of cookie. Does nothing if no choice was recorded in this request.
 */
export function commitSessionPersistence(cookies: AstroCookies): void {
  const sessionOnly = chosenThisRequest.get(cookies);
  if (sessionOnly === undefined) return;
  if (sessionOnly) {
    cookies.set(SESSION_ONLY_COOKIE, '1', { ...HOST_COOKIE_BASE, httpOnly: true });
  } else {
    deleteHostCookie(cookies, SESSION_ONLY_COOKIE);
  }
}

/**
 * Request-scoped Supabase client bound to Astro's cookie jar. Reads the session from
 * `__Host-` cookies and writes rotated tokens straight back onto the response.
 */
export function createSessionClient(cookies: AstroCookies): SupabaseClient {
  return createServerClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    cookieOptions: { name: SESSION_COOKIE_NAME, ...SESSION_COOKIE_OPTIONS },
    cookies: {
      getAll() {
        // Astro has no "list all cookies" API, and @supabase/ssr chunks large tokens
        // into `<name>.0`, `<name>.1`, … so we probe the chunk sequence explicitly.
        // 8 chunks ≈ 32 KB of token, far past anything GoTrue emits.
        const out: { name: string; value: string }[] = [];
        const base = cookies.get(SESSION_COOKIE_NAME);
        if (base?.value) out.push({ name: SESSION_COOKIE_NAME, value: base.value });
        for (let i = 0; i < SESSION_CHUNKS; i += 1) {
          const chunkName = `${SESSION_COOKIE_NAME}.${i}`;
          const chunk = cookies.get(chunkName);
          if (!chunk?.value) break;
          out.push({ name: chunkName, value: chunk.value });
        }
        return out;
      },
      setAll(toSet: SessionCookieWrite[]) {
        writeSessionCookies(cookies, toSet);
      },
    },
  });
}

/** One cookie @supabase/ssr asks to write: a token chunk, or a removal (Max-Age 0). */
export interface SessionCookieWrite {
  name: string;
  value: string;
  options: CookieOptions;
}

/**
 * The session client's `setAll`: writes what @supabase/ssr asks for with OUR attributes.
 *
 * Ours WIN over the library's, and `domain` is never forwarded at all. A `__Host-` cookie
 * carrying a Domain attribute is rejected outright by the browser, so a future default in
 * @supabase/ssr that set one would not weaken the session — it would silently log
 * everyone out, which is a much harder bug to read than this explicit mapping. Max-Age is
 * ours as well (see the header): the library's own is 400 days.
 */
export function writeSessionCookies(
  cookies: AstroCookies,
  toSet: readonly SessionCookieWrite[],
): void {
  const sessionOnly = isSessionOnly(cookies);
  for (const { name, value, options } of toSet) {
    const maxAge = sessionCookieMaxAge(options.maxAge, sessionOnly);
    cookies.set(name, value, {
      path: HOST_COOKIE_BASE.path,
      secure: HOST_COOKIE_BASE.secure,
      sameSite: HOST_COOKIE_BASE.sameSite,
      httpOnly: true,
      ...(maxAge === undefined ? {} : { maxAge }),
    });
  }
}

/**
 * Deletes a `__Host-` cookie. The deletion carries the prefix's attributes: a browser
 * refuses a `__Host-` Set-Cookie without `Secure` and `Path=/`, the expiring one included,
 * and keeps the cookie.
 */
function deleteHostCookie(cookies: AstroCookies, name: string): void {
  cookies.delete(name, { ...HOST_COOKIE_BASE, httpOnly: true });
}

/**
 * Clears the session cookie, every chunk it may have been split across, and the
 * session-only marker.
 */
export function clearSessionCookies(cookies: AstroCookies): void {
  deleteHostCookie(cookies, SESSION_COOKIE_NAME);
  for (let i = 0; i < SESSION_CHUNKS; i += 1) {
    deleteHostCookie(cookies, `${SESSION_COOKIE_NAME}.${i}`);
  }
  deleteHostCookie(cookies, SESSION_ONLY_COOKIE);
}
