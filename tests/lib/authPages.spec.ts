import { beforeEach, describe, expect, it, vi } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { CSRF_FIELD_NAME } from '@/lib/http/csrf';
import { FORGOT_MESSAGES, FORGOT_NOT_SET_UP, LOGIN_MESSAGES } from '@/lib/auth/messages';
import { EXPIRED_FORM } from '@/lib/auth/expiredForm';

// The sign-in screens' server markup (Admin v2 F7), rendered by Astro's container API
// (tests/stubs/astro-components.ts) in states the browser suites cannot reach. The CI
// preview is built with AUTH_EMAIL_READY off (owner item O-2), so tests/e2e only ever sees
// "Forgot password?" saying "Not set up"; the screen people get once e-mail is set up was
// never rendered by any test (F7 review). Here, both:
//   - set up: a form that posts to the endpoint with the CSRF field, no script, no style=
//     attribute, and each status code's fixed copy under the right role, an unknown code
//     rendering nothing;
//   - not set up: no form at all, and the notice.
// And a form the middleware sent back because its CSRF token no longer matched
// (src/lib/auth/expiredForm.ts): each page says so, and the reset page keeps its form.
// The endpoint behind the form (a form post's 303 with each code) is tests/authz/recovery.spec.ts.

const state = vi.hoisted(() => ({ ready: true }));
vi.mock('@/lib/auth/recovery', () => ({ authEmailReady: () => state.ready }));
// The shell's stand-in, named by a template so tsc does not look for an `.astro` module's
// types (it has none; astro check reads the components themselves).
vi.mock('@/layouts/AuthLayout.astro', () => import(`../stubs/${'AuthLayout'}.astro`));

const ORIGIN = 'https://admin.example.test';
const TOKEN = 'csrf-token-from-the-middleware';

beforeEach(() => {
  state.ready = true;
});

/** What the middleware leaves for a page reached without a session (src/middleware.ts). */
const LOCALS = { csrfToken: TOKEN, session: null } as Partial<App.Locals> as App.Locals;

async function render(page: 'login' | 'forgot' | 'reset', search = ''): Promise<string> {
  const { default: Page } = await import(`@/pages/admin/${page}.astro`);
  const container = await AstroContainer.create();
  return container.renderToString(Page, {
    request: new Request(`${ORIGIN}/admin/${page}${search}`),
    locals: LOCALS,
  });
}

/** The parts of a rendered page every sign-in screen must keep (CLAUDE.md §3 CSP). */
function expectNoScriptOrInlineStyle(html: string) {
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/\sstyle=/i);
  expect(html).not.toMatch(/\son[a-z]+=/i);
}

/** Every element carrying class `msg`, with its role and text. */
function messages(html: string): { role: string | null; text: string }[] {
  return [...html.matchAll(/<(p|div) class="msg[^"]*"([^>]*)>([\s\S]*?)<\/\1>/g)].map((m) => ({
    role: /role="([^"]+)"/.exec(m[2] ?? '')?.[1] ?? null,
    text: (m[3] ?? '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  }));
}

describe('/admin/forgot, with e-mail set up (AUTH_EMAIL_READY)', () => {
  it('is a plain form that posts to the endpoint, carrying the CSRF token', async () => {
    const html = await render('forgot');
    const form = /<form([^>]*)>([\s\S]*?)<\/form>/.exec(html);
    expect(form, 'the form').not.toBeNull();
    expect(form?.[1]).toContain('method="post"');
    expect(form?.[1]).toContain('action="/api/admin/auth/forgot"');
    expect(form?.[2]).toContain(`<input type="hidden" name="${CSRF_FIELD_NAME}" value="${TOKEN}">`);
    expect(form?.[2]).toMatch(/<input type="email" name="email" autocomplete="username" required/);
    expect(form?.[2]).toMatch(/<button type="submit"[^>]*>\s*Send reset link\s*<\/button>/);
    expect(html).not.toContain(FORGOT_NOT_SET_UP.title);
    expectNoScriptOrInlineStyle(html);
    expect(messages(html)).toEqual([]);
  });

  it.each([
    ['sent', 'status'],
    ['limited', 'alert'],
    ['unavailable', 'alert'],
  ] as const)('?status=%s renders its fixed copy as role=%s', async (status, role) => {
    const html = await render('forgot', `?status=${status}`);
    expect(messages(html)).toEqual([{ role, text: FORGOT_MESSAGES[status].text }]);
    // The form stays: a person can try again (or another address).
    expect(html).toContain('action="/api/admin/auth/forgot"');
    expectNoScriptOrInlineStyle(html);
  });

  it('an unknown or crafted status renders nothing of it', async () => {
    for (const status of ['nope', '<b>x</b>', 'toString', '__proto__']) {
      const html = await render('forgot', `?status=${encodeURIComponent(status)}`);
      expect(messages(html), status).toEqual([]);
      expect(html).not.toContain('<b>x</b>');
    }
  });
});

describe('/admin/forgot, while e-mail is not set up (owner item O-2)', () => {
  it('offers no form, says "Not set up", and ignores a status', async () => {
    state.ready = false;
    const html = await render('forgot', '?status=sent');
    expect(html).not.toMatch(/<form/);
    expect(html).not.toContain(FORGOT_MESSAGES.sent.text);
    expect(messages(html)).toEqual([
      { role: 'status', text: `${FORGOT_NOT_SET_UP.title} ${FORGOT_NOT_SET_UP.text}` },
    ]);
    expect(html).toContain('href="/admin/login"');
    expectNoScriptOrInlineStyle(html);
  });
});

describe('a form the CSRF check sent back (src/lib/auth/expiredForm.ts)', () => {
  const RESET_TOKEN = 'a1b2c3d4'.repeat(7);
  const expired = LOGIN_MESSAGES[EXPIRED_FORM].text;

  it.each([
    ['login', `?error=${EXPIRED_FORM}`],
    ['forgot', `?status=${EXPIRED_FORM}`],
    ['reset', `?token_hash=${RESET_TOKEN}&type=recovery&error=${EXPIRED_FORM}`],
  ] as const)('/admin/%s says so, as an alert, and offers the form again', async (page, search) => {
    const html = await render(page, search);
    expect(messages(html)).toEqual([{ role: 'alert', text: expired }]);
    expect(html).toContain(`action="/api/admin/auth/${page}"`);
    expect(html).toContain(`name="${CSRF_FIELD_NAME}" value="${TOKEN}"`);
    expectNoScriptOrInlineStyle(html);
  });

  it('the reset page keeps the link: the token rides in the form again', async () => {
    const html = await render(
      'reset',
      `?token_hash=${RESET_TOKEN}&type=recovery&error=${EXPIRED_FORM}`,
    );
    expect(html).toContain(`<input type="hidden" name="token_hash" value="${RESET_TOKEN}">`);
    expect(html).not.toContain('Ask for a new link');
  });

  it('sign-in keeps where the person was going', async () => {
    const html = await render('login', `?next=%2Fadmin%2Fusers&error=${EXPIRED_FORM}`);
    expect(html).toContain('<input type="hidden" name="next" value="/admin/users">');
  });
});
