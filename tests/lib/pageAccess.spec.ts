import { describe, expect, it } from 'vitest';
import {
  PAGE_ACCESS_COOKIE_ATTRS,
  PAGE_ACCESS_MAX_AGE_SECONDS,
  mintAccessCookie,
  pageAccessCookieName,
  pageAccessSetCookie,
  timingSafeEqualHex,
  verifyAccessCookie,
} from '@/lib/visibility/access';
import { escapeHtml, pageAccessGate } from '@/lib/visibility/gate';
import { PAGE_ACCESS_FIELDS } from '@schemas/visibility';

// The proof that a visitor typed a page's password (Admin v2 U14b), and the box that asks
// for it. Nothing here touches a password: the cookie says only which page was opened, at
// which password version, until when — and the gate renders a message the admin wrote.

const KEY = 'test-root-key';
const PAGE = '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const OTHER = '9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d';
const NOW = Date.parse('2026-10-17T09:00:00Z');

describe('the unlock cookie', () => {
  it('is named for its page, and carries the `__Host-` prefix with the attributes it needs', async () => {
    expect(pageAccessCookieName(PAGE)).toBe('__Host-braiin-pa-3f1b2c4d5e6f4a7b8c9d0e1f2a3b4c5d');
    // `__Host-` is only honoured with Secure, Path=/ and no Domain: that is what keeps a
    // sibling host from writing one for this origin.
    expect(PAGE_ACCESS_COOKIE_ATTRS).toContain('Secure');
    expect(PAGE_ACCESS_COOKIE_ATTRS).toContain('Path=/');
    expect(PAGE_ACCESS_COOKIE_ATTRS).toContain('HttpOnly');
    expect(PAGE_ACCESS_COOKIE_ATTRS).toContain('SameSite=Lax');
    expect(PAGE_ACCESS_COOKIE_ATTRS).not.toMatch(/Domain=/i);
    expect(PAGE_ACCESS_MAX_AGE_SECONDS).toBe(12 * 60 * 60);
    const header = await pageAccessSetCookie(KEY, { pageId: PAGE, pv: 1 }, NOW);
    expect(header.startsWith(`${pageAccessCookieName(PAGE)}=`)).toBe(true);
    expect(header).toContain(PAGE_ACCESS_COOKIE_ATTRS);
  });

  it('holds nothing about the password: the page, its version and an expiry', async () => {
    const value = await mintAccessCookie(KEY, { pageId: PAGE, pv: 7 }, NOW);
    const payload = Buffer.from(value.split('.')[0]!, 'base64url').toString('utf8');
    expect(payload).toBe(`v1|${PAGE}|7|${Math.floor(NOW / 1000) + PAGE_ACCESS_MAX_AGE_SECONDS}`);
    expect(value).not.toMatch(/\$2[aby]\$/);
  });

  it('verifies for its own page at its own version, and for nothing else', async () => {
    const value = await mintAccessCookie(KEY, { pageId: PAGE, pv: 2 }, NOW);
    expect(await verifyAccessCookie(KEY, value, { pageId: PAGE, pv: 2 }, NOW)).toBe(true);
    // Another page's gate, even though the browser sends every cookie on every path.
    expect(await verifyAccessCookie(KEY, value, { pageId: OTHER, pv: 2 }, NOW)).toBe(false);
    // The password changed: the version moved, so the cookie stops working.
    expect(await verifyAccessCookie(KEY, value, { pageId: PAGE, pv: 3 }, NOW)).toBe(false);
    // Another deployment's key.
    expect(await verifyAccessCookie('other-root-key', value, { pageId: PAGE, pv: 2 }, NOW)).toBe(
      false,
    );
  });

  it('expires, to the second', async () => {
    const value = await mintAccessCookie(KEY, { pageId: PAGE, pv: 1 }, NOW);
    const expiry = NOW + PAGE_ACCESS_MAX_AGE_SECONDS * 1000;
    expect(await verifyAccessCookie(KEY, value, { pageId: PAGE, pv: 1 }, expiry - 1000)).toBe(true);
    expect(await verifyAccessCookie(KEY, value, { pageId: PAGE, pv: 1 }, expiry)).toBe(false);
  });

  it('refuses a cookie that was edited, in the payload or in the signature', async () => {
    const value = await mintAccessCookie(KEY, { pageId: PAGE, pv: 1 }, NOW);
    const [encoded, signature] = value.split('.') as [string, string];
    const claim = { pageId: PAGE, pv: 1 };
    // The payload rewritten to name a later version, keeping the old signature.
    const forged = Buffer.from(`v1|${PAGE}|2|${Math.floor(NOW / 1000) + 60}`).toString('base64url');
    expect(await verifyAccessCookie(KEY, `${forged}.${signature}`, claim, NOW)).toBe(false);
    // One hex digit of the signature changed.
    const flipped = signature.slice(0, -1) + (signature.endsWith('a') ? 'b' : 'a');
    expect(await verifyAccessCookie(KEY, `${encoded}.${flipped}`, claim, NOW)).toBe(false);
    for (const bad of [
      null,
      undefined,
      '',
      encoded,
      `${encoded}.`,
      `.${signature}`,
      `${encoded}.${signature.slice(0, 63)}`,
      `${encoded}.${signature.toUpperCase()}`,
      `not base64!.${signature}`,
      `${encoded}.${signature}${'x'.repeat(600)}`,
    ]) {
      expect(await verifyAccessCookie(KEY, bad, claim, NOW), String(bad)).toBe(false);
    }
  });

  it('compares signatures without stopping at the first difference', () => {
    expect(timingSafeEqualHex('abc', 'abc')).toBe(true);
    expect(timingSafeEqualHex('abc', 'abd')).toBe(false);
    expect(timingSafeEqualHex('abc', 'ab')).toBe(false);
  });
});

describe('the password box', () => {
  const gate = (over: Partial<Parameters<typeof pageAccessGate>[0]> = {}) =>
    pageAccessGate({
      nonce: 'bm9uY2U=',
      locale: 'en',
      page: 'about',
      next: '/about',
      note: null,
      wrong: false,
      ...over,
    });

  it('is a 403 that no cache keeps and no crawler indexes', async () => {
    const res = gate();
    expect(res.status).toBe(403);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(await res.text()).toContain('content="noindex,nofollow"');
  });

  it('is a plain form with no script and no inline style attribute', async () => {
    const html = await gate().text();
    expect(html).toContain('<form method="post" action="/api/page-access">');
    expect(html).toContain(`name="${PAGE_ACCESS_FIELDS.page}" value="about"`);
    expect(html).toContain(`name="${PAGE_ACCESS_FIELDS.next}" value="/about"`);
    expect(html).toContain(`name="${PAGE_ACCESS_FIELDS.password}" type="password"`);
    expect(html).toContain('<label for="page-password">');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\sstyle="/);
    // One nonced <style>, as the maintenance page does it: the CSP has no 'unsafe-inline'.
    expect(html.match(/<style nonce="bm9uY2U="/g)).toHaveLength(1);
  });

  it('escapes the message the admin wrote, so a note can never become markup', async () => {
    const html = await gate({
      note: { en: 'Ask <script>alert(1)</script> & "the studio"' },
    }).text();
    expect(html).toContain(
      'Ask &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;the studio&quot;',
    );
    expect(html).not.toContain('<script>alert(1)');
  });

  it('nonce: only the base64 alphabet reaches the attribute', async () => {
    const html = await gate({ nonce: 'abc"><script>x</script>' }).text();
    expect(html).toContain('<style nonce="abcscriptx/script">');
  });

  it('speaks the visitor’s language, and falls back to the other when only one is written', async () => {
    const ar = await gate({
      locale: 'ar',
      page: 'about',
      next: '/ar/about',
      note: { ar: 'اطلب كلمة المرور من الاستوديو.' },
    }).text();
    expect(ar).toContain('<html lang="ar" dir="rtl">');
    expect(ar).toContain('اطلب كلمة المرور من الاستوديو.');
    expect(ar).toContain('value="/ar/about"');
    const enOnly = await gate({ locale: 'ar', note: { en: 'Ask the studio.' } }).text();
    expect(enOnly).toContain('Ask the studio.');
    const none = await gate({ locale: 'ar', note: null }).text();
    expect(none).toContain('اكتب كلمة المرور');
  });

  it('says a try failed without echoing a word of what was typed', async () => {
    const html = await gate({ wrong: true }).text();
    expect(html).toContain('That password did not work.');
    expect(html).toContain('role="alert"');
    expect(html).toMatch(/type="password"[^>]*>/);
    expect(html).not.toMatch(/type="password"[^>]*value=/);
  });

  it('escapes every character that could leave an attribute or a text node', () => {
    expect(escapeHtml('<a href="x" \'y\'>&')).toBe('&lt;a href=&quot;x&quot; &#39;y&#39;&gt;&amp;');
  });
});
