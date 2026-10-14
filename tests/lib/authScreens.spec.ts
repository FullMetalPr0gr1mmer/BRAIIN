import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_NEXT, safeNext } from '@/lib/auth/next';
import { LOCKOUT_DURATION_MINUTES } from '@/lib/auth/lockout';
import { readAuthBody, seeOther, ticked } from '@/lib/auth/body';
import {
  FORGOT_MESSAGES,
  FORGOT_NOT_SET_UP,
  LOGIN_MESSAGES,
  RESET_DONE,
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
import { EXPIRED_FORM, expiredFormLocation } from '@/lib/auth/expiredForm';
import { PASSWORD_MIN } from '@schemas/adminPrefs';
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
});

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
    // Plus the middleware's, for a form post that failed the token check (expiredForm.ts).
    expect(Object.keys(RESET_MESSAGES).sort()).toEqual([...codes, EXPIRED_FORM].sort());
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
      FORGOT_NOT_SET_UP.title,
      FORGOT_NOT_SET_UP.text,
    ];
    for (const text of all) expect(text, text).not.toMatch(/[–—]/);
    // And the screens' own words.
    for (const file of [
      'src/pages/admin/login.astro',
      'src/pages/admin/forgot.astro',
      'src/pages/admin/reset.astro',
      'src/layouts/AuthLayout.astro',
    ]) {
      const markup = readFileSync(file, 'utf8').split('---').slice(2).join('---');
      const visible = markup.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
      expect(visible, file).not.toMatch(/[–—]/);
    }
  });

  it('every page has copy for a form sent back by the CSRF check, and it keeps the reset link', () => {
    for (const table of [LOGIN_MESSAGES, FORGOT_MESSAGES, RESET_MESSAGES]) {
      expect(messageFor(table, EXPIRED_FORM)).toEqual({
        kind: 'error',
        text: 'This page was open too long. Please try again.',
      });
    }
    expect(RESET_LINK_SPENT.has(EXPIRED_FORM)).toBe(false);
    // Each page reads the code under its own key (forgot's outcomes are a `status`).
    for (const [endpoint, page] of [
      ['/api/admin/auth/login', '/admin/login?error='],
      ['/api/admin/auth/forgot', '/admin/forgot?status='],
      ['/api/admin/auth/reset', '/admin/reset?error='],
    ] as const) {
      expect(expiredFormLocation(endpoint, new URLSearchParams())).toBe(`${page}${EXPIRED_FORM}`);
    }
    for (const other of ['/api/admin/auth/logout', '/api/admin/auth/login/', '/admin/login']) {
      expect(expiredFormLocation(other, new URLSearchParams()), other).toBeNull();
    }
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
