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
// and Firefox) rather than a LAN IP.
//
// The client this returns is the ANON-key client carrying the user's JWT, so every
// query it makes runs as `authenticated` and RLS applies as the PRIMARY authz layer.
// The service-role client (src/lib/supabase/server.ts) bypasses RLS and is reserved
// for the few paths that must (login lockout, user administration, exports) — each of
// which pairs it with assertCap() and an explicit tenant predicate.

export const SESSION_COOKIE_NAME = '__Host-braiin-auth';

/** Shared by the session cookie and the CSRF cookie so the attributes cannot drift. */
export const HOST_COOKIE_BASE = {
  path: '/',
  secure: true,
  sameSite: 'lax',
} as const;

// 7 days. Supabase refreshes the access token inside this window; the refresh token
// rotating is what actually bounds the session.
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

const SESSION_COOKIE_OPTIONS: CookieOptions = {
  ...HOST_COOKIE_BASE,
  httpOnly: true,
  maxAge: SESSION_MAX_AGE_SECONDS,
};

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
        for (let i = 0; i < 8; i += 1) {
          const chunkName = `${SESSION_COOKIE_NAME}.${i}`;
          const chunk = cookies.get(chunkName);
          if (!chunk?.value) break;
          out.push({ name: chunkName, value: chunk.value });
        }
        return out;
      },
      setAll(toSet: { name: string; value: string; options: CookieOptions }[]) {
        for (const { name, value, options } of toSet) {
          // Our attributes WIN over the library's, and `domain` is never forwarded at
          // all. A `__Host-` cookie carrying a Domain attribute is rejected outright by
          // the browser, so a future default in @supabase/ssr that set one would not
          // weaken the session — it would silently log everyone out, which is a much
          // harder bug to read than this three-line explicit mapping.
          cookies.set(name, value, {
            path: HOST_COOKIE_BASE.path,
            secure: HOST_COOKIE_BASE.secure,
            sameSite: HOST_COOKIE_BASE.sameSite,
            httpOnly: true,
            maxAge: options.maxAge ?? SESSION_MAX_AGE_SECONDS,
          });
        }
      },
    },
  });
}

/** Clears the session cookie and every chunk it may have been split across. */
export function clearSessionCookies(cookies: AstroCookies): void {
  cookies.delete(SESSION_COOKIE_NAME, { path: '/' });
  for (let i = 0; i < 8; i += 1) {
    cookies.delete(`${SESSION_COOKIE_NAME}.${i}`, { path: '/' });
  }
}
