import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AstroCookies as AstroCookiesType } from 'astro';
// Astro's own cookie jar, the one every request gets: its Set-Cookie headers are what the
// browser receives. Not in astro's package exports, so it is reached by path.
import { AstroCookies } from '../../node_modules/astro/dist/core/cookies/index.js';
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  SESSION_ONLY_COOKIE,
  chooseSessionPersistence,
  clearSessionCookies,
  commitSessionPersistence,
  isSessionOnly,
  sessionCookieMaxAge,
  writeSessionCookies,
} from '@/lib/auth/session';

// The admin session cookie (CLAUDE.md §3: `__Host-`, httpOnly, Secure, SameSite=Lax) and
// "Keep me signed in" (Admin v2 F7, owner item O-14). Driven through Astro's real cookie
// jar, reading the Set-Cookie headers a browser would get:
//   - kept (the default): Max-Age 7 days, whatever @supabase/ssr asks for (its own default
//     is 400 days, which is what the cookie carried before F7);
//   - not kept: no Max-Age and no Expires, a session cookie, across token refreshes too;
//   - a removal stays a removal (Max-Age 0);
//   - every deletion of a `__Host-` cookie carries Secure and Path=/, without which a
//     browser refuses it and the cookie stays;
//   - the choice reaches the browser's marker only when the sign-in succeeded (commit), so
//     a failed attempt leaves the lifetime of a session already open as it was.

/** What @supabase/ssr 0.5 passes for a token chunk: its 400-day default Max-Age. */
const LIBRARY_SET = {
  path: '/',
  sameSite: 'lax' as const,
  httpOnly: false,
  maxAge: 400 * 24 * 60 * 60,
};
const LIBRARY_REMOVE = { ...LIBRARY_SET, maxAge: 0 };

function jar(cookieHeader = ''): AstroCookiesType {
  const request = new Request('https://admin.example.test/admin', {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  });
  // The logger is only for a cookie set after the response went out, which never happens here.
  const logger = { warn: () => undefined } as unknown as ConstructorParameters<
    typeof AstroCookies
  >[1];
  return new AstroCookies(request, logger) as unknown as AstroCookiesType;
}

/** Set-Cookie lines by cookie name. */
function headers(cookies: AstroCookiesType): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of (cookies as unknown as { headers(): Iterable<string> }).headers()) {
    out.set(line.slice(0, line.indexOf('=')), line);
  }
  return out;
}

function hostPrefixed(line: string | undefined) {
  expect(line).toBeDefined();
  expect(line).toMatch(/; Secure/i);
  expect(line).toMatch(/; Path=\/(;|$)/i);
  expect(line).not.toMatch(/; Domain=/i);
}

describe('the session cookie a sign-in writes', () => {
  it('kept: Max-Age 7 days, not the library’s 400, with the __Host- attributes', () => {
    const cookies = jar();
    chooseSessionPersistence(cookies, true);
    writeSessionCookies(cookies, [
      { name: SESSION_COOKIE_NAME, value: 'token', options: LIBRARY_SET },
    ]);
    const line = headers(cookies).get(SESSION_COOKIE_NAME);
    hostPrefixed(line);
    expect(line).toMatch(new RegExp(`; Max-Age=${SESSION_MAX_AGE_SECONDS}(;|$)`));
    expect(line).toMatch(/; HttpOnly/i);
    expect(line).toMatch(/; SameSite=Lax/i);
    expect(SESSION_MAX_AGE_SECONDS).toBe(604_800);
  });

  it('not kept: a session cookie, with neither Max-Age nor Expires', () => {
    const cookies = jar();
    chooseSessionPersistence(cookies, false);
    writeSessionCookies(cookies, [
      { name: SESSION_COOKIE_NAME, value: 'token', options: LIBRARY_SET },
      { name: `${SESSION_COOKIE_NAME}.0`, value: 'chunk', options: LIBRARY_SET },
    ]);
    for (const name of [SESSION_COOKIE_NAME, `${SESSION_COOKIE_NAME}.0`]) {
      const line = headers(cookies).get(name);
      hostPrefixed(line);
      expect(line).not.toMatch(/Max-Age|Expires/i);
    }
    // And the marker that says so, once the sign-in has succeeded, is itself a session
    // cookie, httpOnly.
    expect(headers(cookies).has(SESSION_ONLY_COOKIE)).toBe(false);
    commitSessionPersistence(cookies);
    const marker = headers(cookies).get(SESSION_ONLY_COOKIE);
    hostPrefixed(marker);
    expect(marker).toMatch(/; HttpOnly/i);
    expect(marker).not.toMatch(/Max-Age|Expires/i);
  });

  it('a later token refresh keeps the choice the browser sent back', () => {
    const kept = jar(`${SESSION_COOKIE_NAME}=old`);
    writeSessionCookies(kept, [{ name: SESSION_COOKIE_NAME, value: 'new', options: LIBRARY_SET }]);
    expect(headers(kept).get(SESSION_COOKIE_NAME)).toMatch(/Max-Age=604800/);

    const sessionOnly = jar(`${SESSION_COOKIE_NAME}=old; ${SESSION_ONLY_COOKIE}=1`);
    expect(isSessionOnly(sessionOnly)).toBe(true);
    writeSessionCookies(sessionOnly, [
      { name: SESSION_COOKIE_NAME, value: 'new', options: LIBRARY_SET },
    ]);
    expect(headers(sessionOnly).get(SESSION_COOKIE_NAME)).not.toMatch(/Max-Age|Expires/i);
  });

  it('ticking the box again drops the marker, with a deletion the browser accepts', () => {
    const cookies = jar(`${SESSION_ONLY_COOKIE}=1`);
    chooseSessionPersistence(cookies, true);
    expect(isSessionOnly(cookies)).toBe(false);
    commitSessionPersistence(cookies);
    const line = headers(cookies).get(SESSION_ONLY_COOKIE);
    hostPrefixed(line);
    expect(line).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it('a removal the library asks for stays a removal, kept or not', () => {
    for (const marker of ['', `${SESSION_ONLY_COOKIE}=1`]) {
      const cookies = jar(marker);
      writeSessionCookies(cookies, [
        { name: `${SESSION_COOKIE_NAME}.1`, value: '', options: LIBRARY_REMOVE },
      ]);
      const line = headers(cookies).get(`${SESSION_COOKIE_NAME}.1`);
      hostPrefixed(line);
      expect(line).toMatch(/; Max-Age=0(;|$)/);
    }
  });

  it('never forwards a Domain, whatever the library passes', () => {
    const cookies = jar();
    writeSessionCookies(cookies, [
      {
        name: SESSION_COOKIE_NAME,
        value: 'token',
        options: { ...LIBRARY_SET, domain: 'example.test', secure: false },
      },
    ]);
    hostPrefixed(headers(cookies).get(SESSION_COOKIE_NAME));
  });
});

describe('the choice, before and after the sign-in succeeds (F7 review)', () => {
  it('a choice alone writes no marker: the browser keeps the one it has', () => {
    for (const [cookie, remember] of [
      [`${SESSION_COOKIE_NAME}=live; ${SESSION_ONLY_COOKIE}=1`, true],
      [`${SESSION_COOKIE_NAME}=live`, false],
    ] as const) {
      const cookies = jar(cookie);
      chooseSessionPersistence(cookies, remember);
      expect(headers(cookies).has(SESSION_ONLY_COOKIE), cookie).toBe(false);
    }
  });

  it("the sign-in's own cookie follows the choice, not the marker the browser sent", () => {
    const cookies = jar(`${SESSION_ONLY_COOKIE}=1`);
    chooseSessionPersistence(cookies, true);
    writeSessionCookies(cookies, [
      { name: SESSION_COOKIE_NAME, value: 'new', options: LIBRARY_SET },
    ]);
    expect(headers(cookies).get(SESSION_COOKIE_NAME)).toMatch(/Max-Age=604800/);

    const unticked = jar();
    chooseSessionPersistence(unticked, false);
    expect(isSessionOnly(unticked)).toBe(true);
  });

  it('a commit with no choice made in this request writes nothing', () => {
    const cookies = jar(`${SESSION_ONLY_COOKIE}=1`);
    commitSessionPersistence(cookies);
    expect([...headers(cookies).keys()]).toEqual([]);
  });

  it('a choice belongs to its own request', () => {
    const one = jar();
    const other = jar(`${SESSION_ONLY_COOKIE}=1`);
    chooseSessionPersistence(one, false);
    expect(isSessionOnly(other)).toBe(true);
    chooseSessionPersistence(other, true);
    expect(isSessionOnly(one)).toBe(true);
    expect(isSessionOnly(other)).toBe(false);
  });
});

describe('sessionCookieMaxAge', () => {
  it('is 0 for a removal, 7 days kept, and absent for a session-only sign-in', () => {
    expect(sessionCookieMaxAge(0, false)).toBe(0);
    expect(sessionCookieMaxAge(0, true)).toBe(0);
    expect(sessionCookieMaxAge(34_560_000, false)).toBe(SESSION_MAX_AGE_SECONDS);
    expect(sessionCookieMaxAge(undefined, false)).toBe(SESSION_MAX_AGE_SECONDS);
    expect(sessionCookieMaxAge(34_560_000, true)).toBeUndefined();
  });
});

describe('clearSessionCookies', () => {
  it('deletes the cookie, its eight chunks and the marker, each with Secure and Path=/', () => {
    const cookies = jar(`${SESSION_COOKIE_NAME}=a; ${SESSION_ONLY_COOKIE}=1`);
    clearSessionCookies(cookies);
    const lines = headers(cookies);
    const names = [
      SESSION_COOKIE_NAME,
      ...Array.from({ length: 8 }, (_, i) => `${SESSION_COOKIE_NAME}.${i}`),
      SESSION_ONLY_COOKIE,
    ];
    expect([...lines.keys()].sort()).toEqual([...names].sort());
    for (const name of names) {
      const line = lines.get(name);
      hostPrefixed(line);
      expect(line, name).toMatch(/Expires=Thu, 01 Jan 1970/);
    }
  });
});

describe('what the standard says these lifetimes bound (F7 review)', () => {
  // CLAUDE.md §3 said sessions last "at most 7 days from their last use", but only the
  // cookie's Max-Age enforces the 7 days: the refresh token inside it stays valid at
  // Supabase Auth until it is revoked or Auth's own session limits end it (a hosted-project
  // setting, launch runbook §2c). The sentence must say which is which.
  const standard = readFileSync('CLAUDE.md', 'utf8');
  const sessions = standard.split(/\r?\n/).find((line) => line.includes('Sessions in `httpOnly;'));

  it("§3 names the cookie's number and the residual behind it", () => {
    expect(sessions, 'the §3 session sentence').toBeDefined();
    expect(sessions).toContain(`Max-Age ${SESSION_MAX_AGE_SECONDS / 86_400} days`);
    expect(sessions).toContain('That bounds the cookie, not the session');
    expect(sessions).toContain('refresh token');
    expect(sessions).toContain('launch runbook §2c');
  });

  it('and nothing in it claims the session itself ends after 7 days', () => {
    expect(standard).not.toMatch(/at most 7 days from their last use/);
    expect(standard).not.toMatch(/a session ends 7 days after its last use/);
    const runbook = readFileSync('docs/launch-runbook.md', 'utf8');
    expect(runbook).toMatch(/^### 2c\. Session limits/m);
  });

  it('the residual waits on the owner in the deviations register, with an owner and an expiry', () => {
    const register = readFileSync('docs/admin-v2/deviations.md', 'utf8');
    const residuals = register.split(/^## /m).find((s) => s.startsWith('Residual risks'));
    const entry = residuals?.split(/^- /m).find((s) => s.includes('copied session cookie'));
    expect(entry, 'the copied-session-cookie residual').toBeDefined();
    expect(entry).toMatch(/\*Owner:\* Kareem \(O-24\)/);
    expect(entry).toMatch(/\*Expiry:\* [^\n]*\d{4}-\d{2}-\d{2}/);
    expect(entry).toContain('runbook §2c');
  });
});
