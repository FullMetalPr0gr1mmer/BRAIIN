import { beforeEach, describe, expect, it, vi } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { CSRF_FIELD_NAME } from '@/lib/http/csrf';
import {
  FORGOT_MESSAGES,
  FORGOT_NOT_SET_UP,
  LOGIN_MESSAGES,
  RESET_MESSAGES,
  RESET_REOPEN,
  RESET_TOO_LARGE,
  INVITE_MESSAGES,
  INVITE_READY,
  INVITE_REOPEN,
  INVITE_TOO_LARGE,
  TWO_STEP_DONE,
  TWO_STEP_LOST,
  TWO_STEP_MESSAGES,
  TWO_STEP_NOT_SET_UP,
} from '@/lib/auth/messages';
import type { TwoStepView } from '@/lib/auth/twoStepFlow';
import { EXPIRED_FORM, expiredSignInForm, tooLargeSignInForm } from '@/lib/auth/expiredForm';
import { IDENTITY } from './fixtures';
import { normalise } from './harness';

// The sign-in screens' server markup (Admin v2 F7), whole pages with their real shell
// (src/layouts/AuthLayout.astro), rendered by Astro's container API in the render project
// (vitest.render.config.ts), in states the browser suites cannot reach. The CI
// preview is built with AUTH_EMAIL_READY off (owner item O-2), so tests/e2e only ever sees
// "Forgot password?" saying "Not set up"; the screen people get once e-mail is set up was
// never rendered by any test (F7 review). Here, both:
//   - set up: a form that posts to the endpoint with the CSRF field, no script, no style=
//     attribute, and each status code's fixed copy under the right role, an unknown code
//     rendering nothing;
//   - not set up: no form at all, and the notice.
// And a form the middleware sent back because its CSRF token no longer matched
// (src/lib/auth/expiredForm.ts): each page says so, and the reset page keeps its form; or
// because it was over the body limit: the reset page, which cannot have the link back, says
// so and to open the link again (both followed from the middleware's own 303).
// The endpoint behind the form (a form post's 303 with each code) is tests/authz/recovery.spec.ts.

const state = vi.hoisted(() => ({ ready: true }));
vi.mock('@/lib/auth/recovery', () => ({ authEmailReady: () => state.ready }));

const ORIGIN = 'https://admin.example.test';
const TOKEN = 'csrf-token-from-the-middleware';

beforeEach(() => {
  state.ready = true;
});

/**
 * What the middleware leaves for a page reached without a session (src/middleware.ts), and
 * the site profile the shell's brand comes from (the render project's fixture).
 */
const LOCALS = {
  csrfToken: TOKEN,
  session: null,
  identity: Promise.resolve(IDENTITY),
} as Partial<App.Locals> as App.Locals;

let container: Promise<AstroContainer> | undefined;

async function render(
  page: 'login' | 'forgot' | 'reset' | 'invite',
  search = '',
  cookie?: string,
): Promise<string> {
  return normalise(await (await renderResponse(page, search, cookie)).text());
}

/** The page's whole response: its markup and the cookies it sets. */
async function renderResponse(
  page: 'login' | 'forgot' | 'reset' | 'invite',
  search = '',
  cookie?: string,
): Promise<Response> {
  const { default: Page } = await import(`@/pages/admin/${page}.astro`);
  container ??= AstroContainer.create();
  return (await container).renderToResponse(Page, {
    request: new Request(`${ORIGIN}/admin/${page}${search}`, {
      headers: cookie === undefined ? {} : { cookie },
    }),
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
      // The page escapes a quote in its copy (the "Forgot password?" pointers).
      .replaceAll('&quot;', '"')
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
    ['login', `?error=${EXPIRED_FORM}`, undefined],
    ['forgot', `?status=${EXPIRED_FORM}`, undefined],
    ['reset', `?error=${EXPIRED_FORM}`, `__Secure-braiin-reset=${RESET_TOKEN}`],
  ] as const)(
    '/admin/%s says so, as an alert, and offers the form again',
    async (page, search, cookie) => {
      const html = await render(page, search, cookie);
      expect(messages(html)).toEqual([{ role: 'alert', text: expired }]);
      expect(html).toContain(`action="/api/admin/auth/${page}"`);
      expect(html).toContain(`name="${CSRF_FIELD_NAME}" value="${TOKEN}"`);
      expectNoScriptOrInlineStyle(html);
    },
  );

  it('the reset page keeps the link: the token rides in the form again', async () => {
    const html = await render(
      'reset',
      `?error=${EXPIRED_FORM}`,
      `__Secure-braiin-reset=${RESET_TOKEN}`,
    );
    expect(html).toContain(`<input type="hidden" name="token_hash" value="${RESET_TOKEN}">`);
    expect(html).not.toContain('Ask for a new link');
  });

  it('sign-in keeps where the person was going', async () => {
    const html = await render('login', `?next=%2Fadmin%2Fusers&error=${EXPIRED_FORM}`);
    expect(html).toContain('<input type="hidden" name="next" value="/admin/users">');
  });
});

describe('/admin/reset finds the link in its URL or, after a 303, in its cookie (F7 review)', () => {
  const LINK = 'a1b2c3d4'.repeat(7);
  const OTHER = 'e5f6a7b8'.repeat(7);
  const hiddenToken = (html: string) =>
    /<input type="hidden" name="token_hash" value="([^"]*)">/.exec(html)?.[1] ?? null;

  it("the e-mail's link: the token from the URL", async () => {
    expect(hiddenToken(await render('reset', `?token_hash=${LINK}&type=recovery`))).toBe(LINK);
  });

  it('a failure that kept the link: the code in the URL, the token from the cookie', async () => {
    const html = await render('reset', '?error=mismatch', `__Secure-braiin-reset=${LINK}`);
    expect(hiddenToken(html)).toBe(LINK);
    expect(messages(html)).toEqual([{ role: 'alert', text: 'The two passwords do not match.' }]);
  });

  it('a fresh click wins over a cookie a while back left; a link without a usable token, too', async () => {
    const cookie = `__Secure-braiin-reset=${OTHER}`;
    expect(hiddenToken(await render('reset', `?token_hash=${LINK}&type=recovery`, cookie))).toBe(
      LINK,
    );
    // A link the page cannot use is not quietly replaced by the cookie's.
    const broken = await render('reset', '?token_hash=x&type=recovery', cookie);
    expect(hiddenToken(broken)).toBeNull();
    expect(broken).toContain('Ask for a new link');
  });

  it('no token anywhere, a cookie of the wrong shape, or a spent code: no form', async () => {
    for (const [search, cookie] of [
      ['?error=mismatch', undefined],
      ['?error=mismatch', '__Secure-braiin-reset=%3Cx%3E'],
      ['?error=refused', `__Secure-braiin-reset=${LINK}`],
    ] as const) {
      const html = await render('reset', search, cookie);
      expect(hiddenToken(html), `${search} ${cookie}`).toBeNull();
      expect(html).toContain('Ask for a new link');
    }
  });
});

describe("the reset page's URL stays out of its own requests' Referer (F7 review)", () => {
  it('only /admin/reset asks for strict-origin (never no-referrer: that sends Origin: null)', async () => {
    const reset = await render('reset', `?token_hash=${'a1b2c3d4'.repeat(7)}&type=recovery`);
    expect(reset).toMatch(
      /<head>[\s\S]*<meta name="referrer" content="strict-origin">[\s\S]*<\/head>/,
    );
    for (const page of ['login', 'forgot'] as const) {
      expect(await render(page), page).not.toContain('name="referrer"');
    }
  });
});

describe('a form the body limit sent back (src/lib/auth/bodyLimit.ts)', () => {
  it.each([
    ['login', '?error=too-large'],
    ['forgot', '?status=too-large'],
  ] as const)('/admin/%s says so, as an alert, with the form', async (page, search) => {
    const html = await render(page, search);
    expect(messages(html)).toEqual([
      { role: 'alert', text: 'That form was too large to send. Please try again.' },
    ]);
    expect(html).toContain(`action="/api/admin/auth/${page}"`);
  });

  it('/admin/reset says so, and to open the link again: the link cannot come back', async () => {
    // Nothing of the post is read, and the page dropped its cookie when it put the link in
    // the form that was sent (second review). The link is not spent: the endpoint never ran.
    const html = await render('reset', '?error=too-large');
    expect(messages(html)).toEqual([{ role: 'alert', text: RESET_TOO_LARGE.text }]);
    expect(html).toContain('Ask for a new link');
    expect(html).not.toContain('name="token_hash"');
    expectNoScriptOrInlineStyle(html);
  });
});

describe('the reset page after the middleware sent its form back, followed (third review)', () => {
  // The middleware's own answers (src/lib/auth/expiredForm.ts), followed as a browser does:
  // to their Location, carrying whatever cookie the 303 set for the page.
  const LINK = 'a1b2c3d4'.repeat(7);
  const resetPost = (fields: Record<string, string>) =>
    new Request(`${ORIGIN}/api/admin/auth/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    });

  /** The page a 303 sends the browser to, with the cookie the 303 set, if any. */
  async function follow(res: Response | null): Promise<string> {
    expect(res?.status).toBe(303);
    const location = new URL(res?.headers.get('location') ?? '', ORIGIN);
    expect(location.pathname).toBe('/admin/reset');
    const cookie = (res?.headers.getSetCookie() ?? []).map((c) => c.split(';')[0]).join('; ');
    return render('reset', location.search, cookie === '' ? undefined : cookie);
  }

  it('over the body limit: no link, and the page says why and how to try again', async () => {
    const res = tooLargeSignInForm(
      resetPost({ token_hash: LINK, password: 'p', confirm: 'p' }),
      '/api/admin/auth/reset',
    );
    expect(res?.headers.getSetCookie()).toEqual([]);
    const html = await follow(res);
    expect(messages(html)).toEqual([{ role: 'alert', text: RESET_TOO_LARGE.text }]);
    expect(html).not.toContain('name="token_hash"');
    expect(html).toContain('Ask for a new link');
  });

  it('a stale token: the link comes back in its cookie, and the form with it', async () => {
    const res = await expiredSignInForm(
      resetPost({ _csrf: 'stale', token_hash: LINK, password: 'p', confirm: 'p' }),
      '/api/admin/auth/reset',
    );
    const html = await follow(res);
    expect(messages(html)).toEqual([{ role: 'alert', text: RESET_MESSAGES[EXPIRED_FORM].text }]);
    expect(html).toContain(`<input type="hidden" name="token_hash" value="${LINK}">`);
    expect(html).not.toContain('Ask for a new link');
  });
});

describe('the reset page drops the kept link once it is in the form (second review)', () => {
  const LINK = 'a1b2c3d4'.repeat(7);
  // The container hands back the page's cookie jar on the response, under the symbol Astro's
  // own server reads to write the Set-Cookie headers (astro/dist/core/cookies/response.js).
  const resetCookies = (res: Response): string[] => {
    const jar = Reflect.get(res, Symbol.for('astro.cookies')) as
      { consume(): Iterable<string> } | undefined;
    return [...(jar?.consume() ?? []), ...res.headers.getSetCookie()].filter((c) =>
      c.startsWith('__Secure-braiin-reset='),
    );
  };

  it('in the same response that puts the token in the form', async () => {
    const res = await renderResponse('reset', '?error=mismatch', `__Secure-braiin-reset=${LINK}`);
    expect(await res.text()).toContain(`<input type="hidden" name="token_hash" value="${LINK}">`);
    const [drop, ...rest] = resetCookies(res);
    expect(rest).toEqual([]);
    expect(drop).toMatch(/Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
    expect(drop).toMatch(/; Path=\/admin\/reset(;|$)/);
    expect(drop).toMatch(/; Secure(;|$)/);
    expect(drop).toMatch(/; HttpOnly(;|$)/);
    expect(drop).toMatch(/; SameSite=Strict(;|$)/i);
  });

  it('a reload then finds no link here, and says to open it again', async () => {
    const html = await render('reset', '?error=mismatch');
    expect(messages(html)).toEqual([{ role: 'alert', text: RESET_REOPEN.text }]);
    expect(html).toContain('Ask for a new link');
    expect(html).not.toContain('name="token_hash"');
  });

  it('a spent link still says it is spent, and a link from the e-mail sets no cookie', async () => {
    expect(messages(await render('reset', '?error=refused'))[0]?.text).toContain('used up');
    const fresh = await renderResponse('reset', `?token_hash=${LINK}&type=recovery`);
    expect(resetCookies(fresh)).toEqual([]);
  });
});

describe('/admin/invite: the page an invite link opens (Admin v2 U12b)', () => {
  const LINK = 'a1b2c3d4'.repeat(7);
  const hiddenToken = (html: string) =>
    /<input type="hidden" name="token_hash" value="([^"]*)">/.exec(html)?.[1] ?? null;
  const inviteCookies = (res: Response): string[] => {
    const jar = Reflect.get(res, Symbol.for('astro.cookies')) as
      { consume(): Iterable<string> } | undefined;
    return [...(jar?.consume() ?? []), ...res.headers.getSetCookie()].filter((c) =>
      c.startsWith('__Secure-braiin-invite='),
    );
  };

  it("the e-mail's link: a plain form to the endpoint, with the CSRF field and the token", async () => {
    const html = await render('invite', `?token_hash=${LINK}&type=invite`);
    const form = /<form([^>]*)>([\s\S]*?)<\/form>/.exec(html);
    expect(form?.[1]).toContain('method="post"');
    expect(form?.[1]).toContain('action="/api/admin/auth/invite"');
    expect(form?.[2]).toContain(`<input type="hidden" name="${CSRF_FIELD_NAME}" value="${TOKEN}">`);
    expect(hiddenToken(html)).toBe(LINK);
    expect(form?.[2]).toMatch(
      /name="password" autocomplete="new-password" required minlength="10"/,
    );
    expect(form?.[2]).toMatch(/name="confirm" autocomplete="new-password" required/);
    expect(form?.[2]).toMatch(/<button type="submit"[^>]*>\s*Set password\s*<\/button>/);
    expect(messages(html)).toEqual([]);
    expectNoScriptOrInlineStyle(html);
    // Its URL carries the token: its own requests send the origin alone as their Referer.
    expect(html).toMatch(/<head>[\s\S]*<meta name="referrer" content="strict-origin">/);
  });

  it('works whether or not e-mail is set up: the token can only come from an invite', async () => {
    state.ready = false;
    expect(hiddenToken(await render('invite', `?token_hash=${LINK}&type=invite`))).toBe(LINK);
  });

  it("a reset link's token, no token, or a spent code: no form, and who to ask", async () => {
    for (const [search, cookie] of [
      [`?token_hash=${LINK}&type=recovery`, undefined],
      ['', undefined],
      ['?error=expired', `__Secure-braiin-invite=${LINK}`],
      ['?error=closed', `__Secure-braiin-invite=${LINK}`],
      ['?error=refused', `__Secure-braiin-invite=${LINK}`],
    ] as const) {
      const html = await render('invite', search, cookie);
      expect(hiddenToken(html), search).toBeNull();
      expect(html).not.toMatch(/<form/);
      expect(messages(html)).toHaveLength(1);
      expectNoScriptOrInlineStyle(html);
    }
    expect(messages(await render('invite'))).toEqual([
      { role: 'alert', text: INVITE_MESSAGES.expired.text },
    ]);
    expect(messages(await render('invite', '?error=closed'))).toEqual([
      { role: 'alert', text: INVITE_MESSAGES.closed.text },
    ]);
  });

  it('a failure that kept the link: the code in the URL, the token from the cookie, dropped at once', async () => {
    const res = await renderResponse('invite', '?error=mismatch', `__Secure-braiin-invite=${LINK}`);
    const html = normalise(await res.text());
    expect(hiddenToken(html)).toBe(LINK);
    expect(messages(html)).toEqual([{ role: 'alert', text: 'The two passwords do not match.' }]);
    const [drop, ...rest] = inviteCookies(res);
    expect(rest).toEqual([]);
    expect(drop).toMatch(/; Path=\/admin\/invite(;|$)/);
    expect(drop).toMatch(/Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
  });

  it('a reload finds no link, and says to open it again; a form too large says why', async () => {
    expect(messages(await render('invite', '?error=mismatch'))).toEqual([
      { role: 'alert', text: INVITE_REOPEN.text },
    ]);
    expect(messages(await render('invite', '?error=too-large'))).toEqual([
      { role: 'alert', text: INVITE_TOO_LARGE.text },
    ]);
  });

  it('a form the CSRF check sent back keeps the link', async () => {
    const html = await render('invite', `?error=${EXPIRED_FORM}`, `__Secure-braiin-invite=${LINK}`);
    expect(hiddenToken(html)).toBe(LINK);
    expect(messages(html)).toEqual([{ role: 'alert', text: LOGIN_MESSAGES[EXPIRED_FORM].text }]);
  });

  it('the sign-in page says the password is set once the invite is accepted', async () => {
    const html = await render('login', '?invite=ready');
    expect(messages(html)).toEqual([{ role: 'status', text: INVITE_READY.text }]);
    // A failure's message wins over it, as over a finished reset's.
    expect(messages(await render('login', '?invite=ready&error=invalid'))).toEqual([
      { role: 'alert', text: LOGIN_MESSAGES.invalid.text },
    ]);
  });
});

// ── /admin/2fa (Admin v2 U17) ───────────────────────────────────────────────────
// The page a session owing its code reaches, in the sign-in shell (the admin shell frames a
// full session's setup and is swept signed in, tests/admin). Every mode of its content
// (TwoStepPanel), in both frames' heading levels: one form per action posting to the page
// with the CSRF field, no script, no style=, labelled inputs, and each code's fixed copy.
// The page imports both frames (AdminLayout's import graph is large): its first, cold render
// takes longer than the default five seconds on a loaded runner.
describe('/admin/2fa: two-step sign-in (Admin v2 U17)', { timeout: 60_000 }, () => {
  const PENDING = {
    userId: '11111111-1111-4111-8111-111111111111',
    tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    email: 'staff@example.test',
    role: 'seo' as const,
    mode: 'challenge' as const,
    factorId: '33333333-3333-4333-8333-333333333333',
  };

  async function renderTwoStep(
    search = '',
    pending: typeof PENDING | { mode: 'enrol' } = PENDING,
  ): Promise<string> {
    const { default: Page } = await import('@/pages/admin/2fa.astro');
    container ??= AstroContainer.create();
    const res = await (
      await container
    ).renderToResponse(Page, {
      request: new Request(`${ORIGIN}/admin/2fa${search}`),
      locals: {
        ...LOCALS,
        supabase: {},
        secondStep: { ...PENDING, ...pending },
      } as unknown as App.Locals,
    });
    return normalise(await res.text());
  }

  async function renderPanel(view: TwoStepView, inShell: boolean): Promise<string> {
    const { default: Panel } =
      await import('@/components/admin/screens/twoStep/TwoStepPanel.astro');
    container ??= AstroContainer.create();
    return normalise(
      await (
        await container
      ).renderToString(Panel, {
        props: { view, message: null, csrfToken: TOKEN, next: '/admin/leads', inShell },
      }),
    );
  }

  const forms = (html: string) =>
    [...html.matchAll(/<form([^>]*)>([\s\S]*?)<\/form>/g)].map((m) => ({
      attrs: m[1] ?? '',
      body: m[2] ?? '',
      intent: /name="intent" value="([a-z]+)"/.exec(m[2] ?? '')?.[1] ?? null,
    }));

  it('the code at sign-in: one h1, a labelled code field, Verify, and Sign out', async () => {
    const html = await renderTwoStep('?next=%2Fadmin%2Fleads');
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toContain('Enter your code');
    const all = forms(html);
    expect(all.map((f) => f.intent)).toEqual(['verify', 'signout']);
    for (const f of all) {
      expect(f.attrs).toContain('method="post"');
      expect(f.attrs).toContain('action="/admin/2fa"');
      expect(f.body).toContain(`<input type="hidden" name="${CSRF_FIELD_NAME}" value="${TOKEN}">`);
    }
    const verify = all[0]?.body ?? '';
    expect(verify).toContain('<input type="hidden" name="next" value="/admin/leads">');
    expect(verify).toMatch(/<label class="field">\s*<span>6-digit code<\/span>\s*<input/);
    expect(verify).toMatch(/autocomplete="one-time-code"/);
    expect(verify).toMatch(/inputmode="numeric"/);
    expect(html).toContain(TWO_STEP_LOST);
    expectNoScriptOrInlineStyle(html);
  });

  it('a forced setup offers Set up and Sign out, nothing else', async () => {
    const html = await renderTwoStep('', { mode: 'enrol' });
    expect(html).toContain('Set up 2FA');
    expect(forms(html).map((f) => f.intent)).toEqual(['start', 'signout']);
    expectNoScriptOrInlineStyle(html);
  });

  it.each(Object.entries(TWO_STEP_MESSAGES))(
    '?error=%s renders its fixed copy',
    async (code, m) => {
      const html = await renderTwoStep(`?error=${code}`);
      expect(messages(html)).toEqual([{ role: 'alert', text: m.text }]);
    },
  );

  it('?done renders its notice; an unknown or crafted code renders nothing', async () => {
    expect(messages(await renderTwoStep('?done=on'))).toEqual([
      { role: 'status', text: TWO_STEP_DONE.on.text },
    ]);
    for (const code of ['nope', '<b>x</b>', 'toString', '__proto__']) {
      const html = await renderTwoStep(`?error=${encodeURIComponent(code)}`);
      expect(messages(html), code).toEqual([]);
      expect(html).not.toContain('<b>x</b>');
    }
  });

  it('the setup step: the key as text and as a link, its form carrying the setup back', async () => {
    const view: TwoStepView = {
      mode: 'setup',
      factorId: PENDING.factorId,
      setupKey: 'JBSWY3DPEHPK3PXP',
      otpauth: 'otpauth://totp/Studio:staff%40example.test?secret=JBSWY3DPEHPK3PXP&issuer=Studio',
    };
    for (const inShell of [false, true]) {
      const html = await renderPanel(view, inShell);
      expect(html).toMatch(inShell ? /<h2[\s>]/ : /<h1[\s>]/);
      expect(html).not.toMatch(inShell ? /<h1[\s>]/ : /<h2[\s>]/);
      expect(html).toContain('JBSW Y3DP EHPK 3PXP');
      expect(html).toContain('<code class="two-step__key" dir="ltr">');
      expect(html).toContain(
        'href="otpauth://totp/Studio:staff%40example.test?secret=JBSWY3DPEHPK3PXP&amp;issuer=Studio"',
      );
      const [confirm, last] = forms(html);
      expect(confirm?.intent).toBe('confirm');
      expect(confirm?.body).toContain(`name="factorId" value="${PENDING.factorId}"`);
      expect(confirm?.body).toContain('name="setupKey" value="JBSWY3DPEHPK3PXP"');
      // Sign out only where the person has no admin to go back to.
      expect(last?.intent ?? null).toBe(inShell ? null : 'signout');
      expect(html.includes('href="/admin/account"')).toBe(inShell);
      expectNoScriptOrInlineStyle(html);
      // The prototype's words: no dashes (P-12).
      expect(html).not.toMatch(/[–—]/);
    }
  });

  it('manage: Turn off 2FA with a code, unless the team requires it', async () => {
    const off = await renderPanel({ mode: 'manage', required: false }, true);
    expect(forms(off).map((f) => f.intent)).toEqual(['off']);
    expect(off).toContain('Turn off 2FA');
    const kept = await renderPanel({ mode: 'manage', required: true }, true);
    expect(forms(kept)).toEqual([]);
    expect(kept).toContain('Your team requires 2FA, so it stays on.');
  });

  it('intro and "Not set up"', async () => {
    const intro = await renderPanel({ mode: 'intro' }, true);
    expect(forms(intro).map((f) => f.intent)).toEqual(['start']);
    const none = await renderPanel({ mode: 'not-set-up' }, true);
    expect(none).toContain(TWO_STEP_NOT_SET_UP.title);
    expect(none).toContain(TWO_STEP_NOT_SET_UP.text);
    expect(forms(none)).toEqual([]);
  });

  it('a two-step form the CSRF check refused goes back to the page with its next', async () => {
    const request = new Request(`${ORIGIN}/admin/2fa`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `${CSRF_FIELD_NAME}=stale&intent=verify&code=123456&next=%2Fadmin%2Fleads`,
    });
    const res = await expiredSignInForm(request, '/admin/2fa');
    expect(res?.status).toBe(303);
    expect(res?.headers.get('location')).toBe(
      `/admin/2fa?next=%2Fadmin%2Fleads&error=${EXPIRED_FORM}`,
    );
    const big = tooLargeSignInForm(
      new Request(`${ORIGIN}/admin/2fa`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'x',
      }),
      '/admin/2fa',
    );
    expect(big?.headers.get('location')).toBe('/admin/2fa?error=too-large');
  });
});
