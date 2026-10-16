import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_NEXT, safeNext } from '@/lib/auth/next';
import { LOCKOUT_DURATION_MINUTES } from '@/lib/auth/lockout';
import { readAuthBody, seeOther, ticked } from '@/lib/auth/body';
import {
  FORGOT_MESSAGES,
  FORGOT_NOT_SET_UP,
  LOGIN_MESSAGES,
  RESET_DONE,
  RESET_REOPEN,
  RESET_TOO_LARGE,
  RESET_LINK_SPENT,
  RESET_MESSAGES,
  messageFor,
} from '@/lib/auth/messages';
import {
  RECOVERY_LIMITS,
  forgotLimitRules,
  resetLimitRules,
  resetPageUrl,
} from '@/lib/auth/recovery';
import { EXPIRED_FORM, FORM_TOO_LARGE, expiredFormLocation } from '@/lib/auth/expiredForm';
import {
  RESET_TOKEN_COOKIE,
  dropResetToken,
  keepResetToken,
  resetTokenFrom,
} from '@/lib/auth/resetToken';
import {
  INVITE_TOKEN_COOKIE,
  dropInviteToken,
  inviteTokenFrom,
  keepInviteToken,
} from '@/lib/auth/inviteToken';
import {
  INVITE_LINK_SPENT,
  INVITE_MESSAGES,
  INVITE_READY,
  INVITE_REOPEN,
  INVITE_TOO_LARGE,
} from '@/lib/auth/messages';
import { inviteLimitRules, invitePageUrl } from '@/lib/auth/recovery';
import { PASSWORD_MIN } from '@schemas/adminPrefs';
// Astro's own path steps (the installed release), to hold safeNext to the path Astro routes.
// Not in astro's package exports, so they are reached by path (as tests/lib/session.spec.ts
// reaches its cookie jar).
import {
  MultiLevelEncodingError,
  validateAndDecodePathname,
} from '../../node_modules/astro/dist/core/util/pathname.js';
import {
  createNormalizedUrl,
  setPathname,
} from '../../node_modules/astro/dist/core/util/normalized-url.js';
import { collapseDuplicateSlashes } from '../../node_modules/astro/dist/core/path.js';
import { PUBLIC_SITE_URL } from '../stubs/astro-env-client';

// The pieces the sign-in screens (Admin v2 F7) are built from: where a sign-in may send the
// browser, how the endpoints read a JS or a no-JS post, and the fixed copy a page renders
// for an outcome code.

describe('safeNext: where a sign-in may send the browser', () => {
  it('keeps a path under /admin, query and fragment included', () => {
    for (const next of [
      '/admin',
      '/admin/',
      '/admin/leads',
      '/admin/leads?stage=new',
      '/admin#x',
    ]) {
      expect(safeNext(next), next).toBe(next);
    }
  });

  it('turns anything else into /admin: absolute, protocol-relative, backslash, other paths', () => {
    for (const next of [
      'https://evil.example/admin',
      '//evil.example/admin',
      '/\\evil.example/admin',
      '/admin\\..\\evil',
      '/administrator',
      '/services',
      'admin',
      '',
      '/admin/\u0000x',
      '/admin/\nx',
      `/admin/${'x'.repeat(2048)}`,
      null,
      42,
    ]) {
      expect(safeNext(next), String(next)).toBe(DEFAULT_NEXT);
    }
  });

  it('judges the path the browser resolves, not the string (F7 review)', () => {
    // Each starts with `/admin/` and resolves outside it: dot segments, encoded dots, and a
    // `..` that leaves a protocol-relative `//evil.example` behind.
    for (const next of [
      '/admin/../services',
      '/admin/..',
      '/admin/%2e%2e/x',
      '/admin/%2E%2e/services',
      '/admin/.%2e/x',
      '/admin/..//evil.example',
      '/admin/x/../../services?next=/admin',
      '/admin/./../..//evil.example/admin',
      // Encoded again: the browser leaves `%252e` alone, Astro decodes it to a dot and
      // routes `/services` (second review).
      '/admin/%252e%252e/services',
      '/admin/%25252e%25252e/x',
      '/admin/x/%252E%252e/%252e%252e/old-page',
      // A path that cannot be decoded: a lone `%E6`, or a run of `%` once decoded (this one
      // fails at its second decoding, well inside Astro's ten: the limit is tested below).
      '/admin/%E6',
      `/admin/${'%25'.repeat(11)}2e`,
    ]) {
      expect(safeNext(next), next).toBe(DEFAULT_NEXT);
    }
    // Dot segments that stay inside /admin are kept, resolved.
    expect(safeNext('/admin/./leads')).toBe('/admin/leads');
    expect(safeNext('/admin/leads/../users?x=1#y')).toBe('/admin/users?x=1#y');
    // A doubled slash is not a host here, but Astro collapses it before it resolves a `..`
    // after it, so it is refused with the rest of what Astro would move (below).
    expect(safeNext('/admin//evil.example')).toBe(DEFAULT_NEXT);
    // Encoded characters that stay inside /admin once decoded are kept as they are.
    expect(safeNext('/admin/leads?q=100%25')).toBe('/admin/leads?q=100%25');
    expect(safeNext('/admin/%2541')).toBe('/admin/%2541');
  });

  it('percent-encodes what is not ASCII, so a Location header can carry it', () => {
    expect(safeNext('/admin/日')).toBe('/admin/%E6%97%A5');
    // Up to nine times longer once encoded: past 2,048 characters it is not kept (the sign-in
    // form carries it, under the pre-auth body limit).
    expect(safeNext(`/admin/${'日'.repeat(226)}`).length).toBe(7 + 226 * 9);
    expect(safeNext(`/admin/${'日'.repeat(227)}`)).toBe(DEFAULT_NEXT);
    expect(safeNext('/admin/x?q=日 a"<>#frag 日')).toBe(
      '/admin/x?q=%E6%97%A5%20a%22%3C%3E#frag%20%E6%97%A5',
    );
  });

  it('whatever it returns is a valid header value (a ByteString), under /admin', () => {
    const inputs = [
      '/admin',
      '/admin/leads?stage=new',
      '/admin/日本語/ü?ä=ö#ß',
      '/admin/\u{1F600}',
      '/admin/x?y=ÿĀ',
      '/admin/a b',
      '/admin/"quoted"',
      '/admin/<tag>',
      '/admin/`tick`{brace}',
      '/admin/%zz',
      '/admin/../services',
      '/admin/..//evil.example',
      '/services',
      'https://evil.example',
    ];
    // Plus every printable ASCII and a sweep of Latin-1 and beyond, one at a time.
    for (let code = 0x20; code < 0x300; code += 1) {
      inputs.push(`/admin/${String.fromCharCode(code)}x`, `/admin?${String.fromCharCode(code)}`);
    }
    for (const input of inputs) {
      const next = safeNext(input);
      expect(() => new Headers({ location: next }), input).not.toThrow();
      expect(next, input).toMatch(/^\/admin(?:[/?#][\x21-\x7e]*)?$/);
      // And the browser lands where it says: resolving it again changes nothing.
      const again = new URL(next, 'https://site.example');
      expect(`${again.pathname}${again.search}${again.hash}`, input).toBe(next);
      expect(again.host, input).toBe('site.example');
    }
  });

  it("refuses a path that needs more decodings than Astro's ten, by that limit (third review)", () => {
    // `%25` decodes to `%`, so each `25` is one decoding more: `/admin/%41` takes one to
    // reach `/admin/A`, and this takes `n`, every one of them succeeding.
    const encoded = (n: number) => `/admin/%${'25'.repeat(n - 1)}41`;
    // Ten, Astro routes `/admin/A`, and the value is kept; eleven, Astro answers 400.
    expect(validateAndDecodePathname(encoded(10))).toBe('/admin/A');
    expect(safeNext(encoded(10))).toBe(encoded(10));
    expect(() => validateAndDecodePathname(encoded(11))).toThrow(MultiLevelEncodingError);
    // Refused by the limit itself: safeNext decodes eleven times, each decoding succeeds and
    // changes the path (so neither a failed decoding nor an ambiguous result refused it), and
    // it stops there, the one way out of its loop that is left.
    const decode = vi.spyOn(globalThis, 'decodeURI');
    try {
      expect(safeNext(encoded(11))).toBe(DEFAULT_NEXT);
      expect(decode).toHaveBeenCalledTimes(11);
      decode.mock.calls.forEach(([input], i) => {
        const result = decode.mock.results[i];
        expect(result?.type, `decoding ${i + 1}`).toBe('return');
        expect(result?.value, `decoding ${i + 1}`).not.toBe(input);
      });
    } finally {
      decode.mockRestore();
    }
  });

  it('refuses a path any step after Astro decodes it could move (third review)', () => {
    for (const next of [
      // The review's: here the empty segment between the slashes took the `..`; Astro
      // collapses the slashes first, and the `..` pops /admin (the middleware reads
      // `/old-page`, a 404 the authored redirects answer).
      '/admin//%252e%252e/old-page',
      '/admin/x//%252e%252e/%252e%252e/old-page',
      '/admin///%252e%252e/%252e%252e/old-page',
      // The same, encoded once more, or with the slashes encoded too.
      '/admin//%25252e%25252e/old-page',
      '/admin/%2F%252e%252e/old-page',
      '/admin/x%252F%252F%252e%252e%252F%252e%252e%252Fold-page',
      // A backslash the URL setter reads as a slash; a tab or newline it drops.
      '/admin/x%5C..%5C..%5Cold-page',
      '/admin/x%255C%252e%252e%255C%252e%252e%255Cold-page',
      '/admin/.%09./old-page',
      '/admin/x/.%250A./.%250A./old-page',
      // And any dot segment, doubled slash or `%` left once decoded, even inside /admin.
      '/admin/x/%252e%252e/leads',
      '/admin/%252e/leads',
      '/admin/x%2Fy',
      '/admin/x%252F%252Fy',
    ]) {
      expect(safeNext(next), next).toBe(DEFAULT_NEXT);
    }
  });

  it("every value it keeps routes under /admin, by Astro's own steps (third review)", () => {
    // Over a corpus of dot, slash, backslash and control-character segments at every depth
    // of encoding Astro decodes, and the review's inputs: whatever safeNext keeps, the router
    // matches, and the middleware reads, under /admin; never the 400 for a path encoded
    // deeper than Astro decodes. Astro's helpers are the installed ones, so a release that
    // would route a kept value elsewhere fails here. (The safeNext before this review kept
    // 537 of these paths that Astro routes outside /admin.)
    const SEGMENTS = [
      '',
      '.',
      '..',
      '%2e',
      '%2E%2e',
      '%252e',
      '%252e%252e',
      '%25252e%25252e',
      '.%252e',
      '%5C',
      'x%5C..',
      'x%255C%252e%252e',
      '%2F',
      '%252F',
      '%09',
      '.%09.',
      '.%2509.',
      '%25',
      '%2541',
      'x',
      'evil.example',
      'a%20b',
      '日',
    ];
    const TAILS = ['', 'old-page', '%252e%252e/old-page', '%252e%252e/%252e%252e/old-page'];
    const inputs = [
      '/admin//%252e%252e/old-page',
      '/admin/x//%252e%252e/%252e%252e/old-page',
      '/admin///%252e%252e/%252e%252e/old-page',
    ];
    for (const head of ['/admin', '/admin/', '/admin//']) {
      for (const a of SEGMENTS) {
        for (const b of SEGMENTS) {
          for (const tail of TAILS) inputs.push(`${head}${a}/${b}/${tail}`);
        }
      }
    }
    let kept = 0;
    for (const input of inputs) {
      const next = safeNext(input);
      if (next !== DEFAULT_NEXT) kept += 1;
      const routed = astroRoutes(next);
      expect(routed, `${input} -> ${next}`).not.toBeNull();
      for (const path of routed ?? []) {
        expect(
          path === '/admin' || path.startsWith('/admin/'),
          `${input} -> ${next} -> ${path}`,
        ).toBe(true);
      }
    }
    // Not a vacuous sweep: a good share is kept, and judged.
    expect(kept).toBeGreaterThan(200);
  });
});

/**
 * Where Astro takes a request for `next`, once a browser has followed it, read with Astro's
 * own helpers: the path its router matches (core/routing/match-request.js: decoded, and
 * nothing else), the path the middleware reads (FetchState's constructor: decoded, slashes
 * collapsed, through the URL setter, collapsed again) and the path after a rewrite
 * (createNormalizedUrl). Null for the 400 Astro answers a path encoded deeper than it decodes.
 */
function astroRoutes(next: string): string[] | null {
  const request = new URL(next, 'https://site.example');
  const raw = request.pathname;
  let decoded = raw;
  try {
    decoded = validateAndDecodePathname(raw);
  } catch (error) {
    if (error instanceof MultiLevelEncodingError) return null;
  }
  const url = new URL(request.href);
  setPathname(url, collapseDuplicateSlashes(decoded));
  setPathname(url, collapseDuplicateSlashes(url.pathname));
  return [decoded, url.pathname, createNormalizedUrl(request.href).pathname];
}

describe('readAuthBody: the two kinds of post', () => {
  const post = (body: BodyInit, type?: string) =>
    new Request('https://admin.example.test/api/admin/auth/login', {
      method: 'POST',
      headers: type ? { 'content-type': type } : {},
      body,
    });

  it('reads a JSON object as JSON', async () => {
    expect(await readAuthBody(post('{"email":"a@b.test"}', 'application/json'))).toEqual({
      kind: 'json',
      fields: { email: 'a@b.test' },
    });
  });

  it('reads a urlencoded form as a form, first value of each field, strings only', async () => {
    const body = 'email=a%40b.test&remember=1&email=second';
    expect(await readAuthBody(post(body, 'application/x-www-form-urlencoded'))).toEqual({
      kind: 'form',
      fields: { email: 'a@b.test', remember: '1' },
    });
  });

  it('refuses multipart, a JSON array or scalar, and JSON that does not parse', async () => {
    const multipart = new FormData();
    multipart.set('email', 'a@b.test');
    expect(await readAuthBody(post(multipart))).toBeNull();
    for (const text of ['[1]', '"x"', 'null', 'email=a']) {
      expect(await readAuthBody(post(text, 'application/json')), text).toBeNull();
    }
  });

  it('ticked: a checkbox is on when it was sent, whatever its value', () => {
    expect(ticked({ remember: '1' }, 'remember')).toBe(true);
    expect(ticked({ remember: '' }, 'remember')).toBe(true);
    expect(ticked({}, 'remember')).toBe(false);
    expect(ticked({ remember: true }, 'remember')).toBe(false);
  });

  it('seeOther: a 303, never cached, with no body', async () => {
    const res = seeOther('/admin/login?error=invalid');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/login?error=invalid');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('');
  });
});

describe('the outcome codes the pages render', () => {
  it('render fixed copy for a known code and nothing for any other', () => {
    expect(messageFor(LOGIN_MESSAGES, 'invalid')).toBe(LOGIN_MESSAGES.invalid);
    expect(messageFor(RESET_MESSAGES, 'mismatch')).toBe(RESET_MESSAGES.mismatch);
    for (const code of [null, '', 'INVALID', '<b>hi</b>', '__proto__', 'constructor', 'toString']) {
      expect(messageFor(LOGIN_MESSAGES, code), String(code)).toBeNull();
      expect(messageFor(FORGOT_MESSAGES, code), String(code)).toBeNull();
      expect(messageFor(RESET_MESSAGES, code), String(code)).toBeNull();
    }
  });

  it('keep the copy sign-in had: one message for every failure, the 15-minute lockout', () => {
    expect(LOGIN_MESSAGES.invalid.text).toBe('Those credentials did not work.');
    expect(LOGIN_MESSAGES.locked.text).toBe('Too many attempts. Try again in 15 minutes.');
  });

  it('a finished reset warns that a lockout outlasts it (F7 review)', () => {
    // A reset does not clear the failures behind a lockout (0009's window), and the usual
    // way to a reset is a few wrong passwords first: without this, the new password is
    // answered "Too many attempts" with nothing to say why.
    expect(RESET_DONE.text).toMatch(/^Your password is changed/);
    expect(RESET_DONE.text).toContain(
      `If sign-in was locked after too many attempts, it opens again within ${LOCKOUT_DURATION_MINUTES} minutes.`,
    );
  });

  it('every reset code the endpoint sends has copy, and the spent ones drop the form', () => {
    // The page codes reset.ts redirects with (its PAGE_CODE table), read from the source so
    // a code added there without copy here fails.
    const source = readFileSync('src/pages/api/admin/auth/reset.ts', 'utf8');
    const table = /const PAGE_CODE[^{]*\{([^}]*)\}/.exec(source)?.[1] ?? '';
    const codes = [...table.matchAll(/:\s*'([a-z-]+)'/g)].map((m) => m[1]!).sort();
    expect(codes).toEqual([
      'expired',
      'interrupted',
      'limited',
      'long',
      'mismatch',
      'refused',
      'short',
      'unavailable',
    ]);
    for (const code of codes) expect(messageFor(RESET_MESSAGES, code), code).not.toBeNull();
    // Plus the middleware's, for a form post that failed the token check or was over the
    // pre-auth body limit (expiredForm.ts).
    expect(Object.keys(RESET_MESSAGES).sort()).toEqual(
      [...codes, EXPIRED_FORM, FORM_TOO_LARGE].sort(),
    );
    // The link is gone after these: the page offers a new one instead of the form.
    expect([...RESET_LINK_SPENT].sort()).toEqual(['expired', 'interrupted', 'refused']);
  });

  it("the reset copy states the account screen's rule (F8), in its words", () => {
    expect(RESET_MESSAGES.short.text).toBe(`Use at least ${PASSWORD_MIN} characters.`);
    expect(RESET_MESSAGES.long.text).toBe('That password is too long. Try a shorter one.');
  });

  it('follow the admin copy rules (P-12): no em or en dash anywhere', () => {
    const all = [
      ...Object.values(LOGIN_MESSAGES).map((m) => m.text),
      ...Object.values(FORGOT_MESSAGES).map((m) => m.text),
      ...Object.values(RESET_MESSAGES).map((m) => m.text),
      RESET_DONE.text,
      RESET_REOPEN.text,
      RESET_TOO_LARGE.text,
      FORGOT_NOT_SET_UP.title,
      FORGOT_NOT_SET_UP.text,
      ...Object.values(INVITE_MESSAGES).map((m) => m.text),
      INVITE_READY.text,
      INVITE_REOPEN.text,
      INVITE_TOO_LARGE.text,
    ];
    for (const text of all) expect(text, text).not.toMatch(/[–—]/);
    // And the screens' own words.
    for (const file of [
      'src/pages/admin/login.astro',
      'src/pages/admin/forgot.astro',
      'src/pages/admin/reset.astro',
      'src/pages/admin/invite.astro',
      'src/layouts/AuthLayout.astro',
    ]) {
      const markup = readFileSync(file, 'utf8').split('---').slice(2).join('---');
      const visible = markup.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
      expect(visible, file).not.toMatch(/[–—]/);
    }
  });

  it('every page has copy for a form sent back by the CSRF check, and it keeps the reset link', () => {
    for (const table of [LOGIN_MESSAGES, FORGOT_MESSAGES, RESET_MESSAGES, INVITE_MESSAGES]) {
      expect(messageFor(table, EXPIRED_FORM)).toEqual({
        kind: 'error',
        text: 'This page was open too long. Please try again.',
      });
    }
    expect(RESET_LINK_SPENT.has(EXPIRED_FORM)).toBe(false);
    expect(INVITE_LINK_SPENT.has(EXPIRED_FORM)).toBe(false);
    for (const table of [LOGIN_MESSAGES, FORGOT_MESSAGES, RESET_MESSAGES, INVITE_MESSAGES]) {
      expect(messageFor(table, FORM_TOO_LARGE)).toEqual({
        kind: 'error',
        text: 'That form was too large to send. Please try again.',
      });
    }
    // Each page reads the code under its own key (forgot's outcomes are a `status`).
    for (const [endpoint, page] of [
      ['/api/admin/auth/login', '/admin/login?error='],
      ['/api/admin/auth/forgot', '/admin/forgot?status='],
      ['/api/admin/auth/reset', '/admin/reset?error='],
      ['/api/admin/auth/invite', '/admin/invite?error='],
    ] as const) {
      expect(expiredFormLocation(endpoint, new URLSearchParams())).toBe(`${page}${EXPIRED_FORM}`);
    }
    for (const other of ['/api/admin/auth/logout', '/api/admin/auth/login/', '/admin/login']) {
      expect(expiredFormLocation(other, new URLSearchParams()), other).toBeNull();
    }
  });

  it('"The link works for one hour" is what the local stack sets, and the runbook pins (F7 review)', () => {
    // The copy promises a lifetime that is a Supabase setting, so the number is held here:
    // supabase/config.toml's [auth.email] otp_expiry, and launch runbook §2b's step for the
    // hosted projects' Email OTP Expiration.
    expect(FORGOT_MESSAGES.sent.text).toContain('The link works for one hour.');
    const config = readFileSync('supabase/config.toml', 'utf8');
    const email = /^\[auth\.email\]\s*$([\s\S]*?)(?=^\[)/m.exec(config)?.[1] ?? '';
    expect(/^otp_expiry\s*=\s*(\d+)\s*$/m.exec(email)?.[1]).toBe('3600');
    const runbook = readFileSync('docs/launch-runbook.md', 'utf8');
    expect(runbook).toContain('**Email OTP Expiration = 3600** seconds');
  });

  it('"Not set up" is said in those words (the program\'s status for a missing account)', () => {
    expect(FORGOT_NOT_SET_UP.title).toBe('Not set up');
  });
});

describe('the recovery limits and link', () => {
  it("the e-mail is counted only when there is one; the tenant's window apart", () => {
    const { caller, tenant } = forgotLimitRules('203.0.113.7', 'a@b.test');
    expect(caller.map((r) => r.scope)).toEqual(['auth.forgot:ip', 'auth.forgot:email']);
    expect(tenant).toEqual({
      scope: 'auth.forgot:tenant',
      value: 'all',
      ...RECOVERY_LIMITS.forgotPerTenant,
    });
    expect(forgotLimitRules(null, null).caller.map((r) => [r.scope, r.value])).toEqual([
      ['auth.forgot:ip', 'unknown'],
    ]);
    expect(resetLimitRules('2001:db8:1:2:3:4:5:6')).toEqual([
      { scope: 'auth.reset:ip', value: '2001:db8:1:2::/64', ...RECOVERY_LIMITS.resetPerIp },
    ]);
  });

  it('the reset link lands on the configured origin, never the request host', () => {
    expect(resetPageUrl()).toBe(`${PUBLIC_SITE_URL}/admin/reset`);
  });
});

describe("the reset link's token between a form post and its page (F7 review)", () => {
  const LINK = 'a1b2c3d4'.repeat(7);

  it('rides in a cookie only the reset page gets, short-lived, never readable by script', () => {
    expect(keepResetToken(LINK)).toBe(
      `${RESET_TOKEN_COOKIE}=${LINK}; Max-Age=900; Path=/admin/reset; Secure; HttpOnly; SameSite=Strict`,
    );
    // Dropped with the same Path, or the browser would keep it.
    expect(dropResetToken()).toBe(
      `${RESET_TOKEN_COOKIE}=; Max-Age=0; Path=/admin/reset; Secure; HttpOnly; SameSite=Strict`,
    );
    // `__Secure-`: the browser refuses it without Secure. Not `__Host-`, which needs Path=/.
    expect(RESET_TOKEN_COOKIE.startsWith('__Secure-')).toBe(true);
  });

  it('only a token of the right shape goes into a header', () => {
    for (const bad of [
      '',
      'x',
      'a; Path=/',
      `${LINK}
Set-Cookie: y=1`,
      'é'.repeat(20),
    ]) {
      expect(() => keepResetToken(bad), bad).toThrow();
    }
  });

  it("the page takes the link's own token first, else the cookie's", () => {
    const params = (search: string) => new URLSearchParams(search);
    expect(resetTokenFrom(params(`token_hash=${LINK}&type=recovery`), undefined)).toBe(LINK);
    expect(resetTokenFrom(params(`token_hash=${LINK}&type=recovery`), 'b'.repeat(56))).toBe(LINK);
    expect(resetTokenFrom(params('error=mismatch'), LINK)).toBe(LINK);
    // A link that carries a token the page cannot use is not swapped for the cookie's.
    expect(resetTokenFrom(params(`token_hash=${LINK}`), LINK)).toBeNull();
    expect(resetTokenFrom(params('token_hash=x&type=recovery'), LINK)).toBeNull();
    expect(resetTokenFrom(params(''), '<x>')).toBeNull();
    expect(resetTokenFrom(params(''), undefined)).toBeNull();
  });
});

describe('accepting an invite (Admin v2 U12b): its codes, its link, its limits', () => {
  const LINK = 'a1b2c3d4'.repeat(7);

  it('every invite code the endpoint sends has copy, and the spent ones drop the form', () => {
    const source = readFileSync('src/pages/api/admin/auth/invite.ts', 'utf8');
    const table = /const PAGE_CODE[^{]*\{([^}]*)\}/.exec(source)?.[1] ?? '';
    const codes = [...table.matchAll(/:\s*'([a-z-]+)'/g)].map((m) => m[1]!).sort();
    expect(codes).toEqual([
      'closed',
      'expired',
      'interrupted',
      'limited',
      'long',
      'mismatch',
      'refused',
      'short',
      'unavailable',
    ]);
    for (const code of codes) expect(messageFor(INVITE_MESSAGES, code), code).not.toBeNull();
    expect(Object.keys(INVITE_MESSAGES).sort()).toEqual(
      [...codes, EXPIRED_FORM, FORM_TOO_LARGE].sort(),
    );
    expect([...INVITE_LINK_SPENT].sort()).toEqual(['closed', 'expired', 'interrupted', 'refused']);
    for (const code of [null, '', '__proto__', 'constructor', '<b>x</b>']) {
      expect(messageFor(INVITE_MESSAGES, code), String(code)).toBeNull();
    }
  });

  it("states the account screen's password rule, and sends a spent link back to an Admin", () => {
    expect(INVITE_MESSAGES.short.text).toBe(`Use at least ${PASSWORD_MIN} characters.`);
    expect(INVITE_MESSAGES.expired.text).toContain('Ask the Admin who invited you');
    // After the verify the account is confirmed and cannot be invited again: "Forgot
    // password?" is its way to a password, never "ask for the invite again".
    // A switched-off account (closed) is confirmed too: the Admin switches it back on first.
    for (const code of ['refused', 'interrupted', 'closed'] as const) {
      expect(INVITE_MESSAGES[code].text).toContain('"Forgot password?"');
      expect(INVITE_MESSAGES[code].text).not.toContain('invite again');
    }
    expect(INVITE_MESSAGES.closed.text).toContain('switch your access back on');
    expect(INVITE_READY.text).toBe(
      'Your password is set. Sign in with your email and the new password.',
    );
  });

  it('rides in a cookie only the invite page gets, short-lived, never readable by script', () => {
    expect(keepInviteToken(LINK)).toBe(
      `${INVITE_TOKEN_COOKIE}=${LINK}; Max-Age=900; Path=/admin/invite; Secure; HttpOnly; SameSite=Strict`,
    );
    expect(dropInviteToken()).toBe(
      `${INVITE_TOKEN_COOKIE}=; Max-Age=0; Path=/admin/invite; Secure; HttpOnly; SameSite=Strict`,
    );
    expect(INVITE_TOKEN_COOKIE.startsWith('__Secure-')).toBe(true);
    for (const bad of [
      '',
      'x',
      'a; Path=/',
      `${LINK}
Set-Cookie: y=1`,
    ]) {
      expect(() => keepInviteToken(bad), bad).toThrow();
    }
  });

  it("the page takes the link's own token first, else the cookie's, and never a reset link's", () => {
    const params = (search: string) => new URLSearchParams(search);
    expect(inviteTokenFrom(params(`token_hash=${LINK}&type=invite`), undefined)).toBe(LINK);
    expect(inviteTokenFrom(params(`token_hash=${LINK}&type=invite`), 'b'.repeat(56))).toBe(LINK);
    expect(inviteTokenFrom(params('error=mismatch'), LINK)).toBe(LINK);
    expect(inviteTokenFrom(params(`token_hash=${LINK}&type=recovery`), LINK)).toBeNull();
    expect(inviteTokenFrom(params(`token_hash=${LINK}`), LINK)).toBeNull();
    expect(inviteTokenFrom(params(''), '<x>')).toBeNull();
    expect(inviteTokenFrom(params(''), undefined)).toBeNull();
  });

  it("counts per address, then the tenant's window; the link lands on the configured origin", () => {
    const { caller, tenant } = inviteLimitRules('203.0.113.7');
    expect(caller).toEqual([
      { scope: 'auth.invite:ip', value: '203.0.113.7', ...RECOVERY_LIMITS.invitePerIp },
    ]);
    expect(tenant).toEqual({
      scope: 'auth.invite:tenant',
      value: 'all',
      ...RECOVERY_LIMITS.invitePerTenant,
    });
    expect(invitePageUrl()).toBe(`${PUBLIC_SITE_URL}/admin/invite`);
  });
});
