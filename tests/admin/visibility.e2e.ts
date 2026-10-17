import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { SKIP_REASON, authFile, staffEnv } from './staff';

// Page visibility (Admin v2 U14a) end to end, through the real Worker, middleware and KV:
// an Admin sets a page through the API and the public site answers for it (a 302 to the
// right twin, the 404 page, link only with noindex, a window of days, a hidden template),
// the menus, the sitemap and llms.txt follow, and the screen's own flow (the drawer, the
// confirm, the toast) with zero axe violations open. Every gated route first answers 200
// with no noindex: the route map in a real build, where a wrong entry would 404 a live page.
//
// Runs in its own project (playwright.config.ts `visibility`), after every other public and
// admin spec, because it hides real pages on the one preview they all share; and it puts
// every setting back to public at the end, so a spec run after it (a retry) finds the site
// as seeded.

test.skip(!staffEnv(), SKIP_REASON);
test.describe.configure({ mode: 'serial' });
test.use({ storageState: authFile('admin'), contextOptions: { reducedMotion: 'reduce' } });

const API = '/api/admin/page-visibility';
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const HOME_REFUSAL = 'The homepage cannot be hidden. Use maintenance mode instead.';

interface Setting {
  id: string;
  mode: 'public' | 'hidden' | 'link' | 'password';
  version: number;
}
interface Item {
  kind: 'page' | 'template';
  id?: string;
  slug?: string;
  template?: string;
  setting: Setting | null;
}
interface List {
  pages: Item[];
  templates: Item[];
}

/** A Riyadh day, `days` from today. */
function riyadhDay(days: number): string {
  return new Date(Date.now() + 3 * 3_600_000 + days * 86_400_000).toISOString().slice(0, 10);
}

async function csrf(page: Page): Promise<string> {
  if (!page.url().includes('/admin')) await page.goto('/admin', { waitUntil: 'networkidle' });
  const token = await page.locator('meta[name="csrf-token"]').getAttribute('content');
  expect(token, 'the admin layout carries a CSRF token').toBeTruthy();
  return token!;
}

async function list(request: APIRequestContext): Promise<List> {
  const res = await request.get(API);
  expect(res.status(), `GET ${API}`).toBe(200);
  return ((await res.json()) as { data: List }).data;
}

/** Sets one page (by slug) or template, at its current version. */
async function setVisibility(
  page: Page,
  target: { slug: string } | { template: string },
  mode: Setting['mode'],
  extras: { redirectSlug?: string; hideFrom?: string; showOn?: string } = {},
  expectStatus = 200,
) {
  const current = await list(page.request);
  const item =
    'slug' in target
      ? current.pages.find((p) => p.slug === target.slug)
      : current.templates.find((t) => t.template === target.template);
  expect(item, JSON.stringify(target)).toBeTruthy();
  const redirect = extras.redirectSlug
    ? (current.pages.find((p) => p.slug === extras.redirectSlug)?.id ?? null)
    : null;
  const res = await page.request.put(API, {
    headers: { 'x-csrf-token': await csrf(page), origin: new URL(page.url()).origin },
    data: {
      target: 'slug' in target ? { pageId: item!.id } : { template: target.template },
      mode,
      redirectPageId: redirect,
      hideFrom: extras.hideFrom ?? null,
      showOn: extras.showOn ?? null,
      version: item!.setting?.version ?? 0,
    },
  });
  expect(res.status(), `PUT ${JSON.stringify(target)} ${mode}: ${await res.text()}`).toBe(
    expectStatus,
  );
  return res;
}

/** The status (and headers) of a public path, no redirect followed, once the edge has it. */
async function answer(request: APIRequestContext, path: string) {
  const res = await request.get(path, { maxRedirects: 0 });
  return { status: res.status(), headers: res.headers(), body: await res.text() };
}

/** Waits until a path answers `status` (the edge snapshot is memoised for up to a minute). */
async function until(request: APIRequestContext, path: string, status: number) {
  await expect
    .poll(async () => (await request.get(path, { maxRedirects: 0 })).status(), {
      message: `${path} answers ${status}`,
      timeout: 75_000,
      intervals: [250, 1000, 2000, 5000],
    })
    .toBe(status);
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

/**
 * A page's words as a reader gets them: scripts, styles and tags gone, the common entities
 * decoded, and every space removed, because a split heading (SplitHeading) puts each word in
 * an element of its own and where the spaces fall between them is markup, not text.
 */
function wordsOf(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTITIES[e] ?? e)
    .replace(/\s+/g, '');
}

/** The words of a page's <h1>, however its markup splits them; '' with no heading. */
function headingWords(html: string): string {
  return wordsOf(/<h1\b[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? '');
}

/** The hrefs of the header and the footer, nothing else of the page. */
function menuLinks(html: string): string[] {
  const parts = [
    /<header class="site-header[\s\S]*?<\/header>/.exec(html)?.[0] ?? '',
    /<footer class="site-footer[\s\S]*?<\/footer>/.exec(html)?.[0] ?? '',
  ];
  expect(
    parts.every((p) => p.length > 0),
    'the page has its header and footer',
  ).toBe(true);
  return parts.flatMap((p) => [...p.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!));
}

const GATED = [
  '/',
  '/ar',
  '/about',
  '/ar/about',
  '/contact',
  '/join',
  '/services',
  '/ar/services',
  '/services/logo',
  '/ar/services/logo',
  '/portfolio',
  '/portfolio/all',
  '/portfolio/the-rider',
  '/ar/portfolio/the-rider',
];

test.afterAll(async ({ browser }) => {
  // Every page and template back to public, whatever a failed test left behind.
  const context = await browser.newContext({ storageState: authFile('admin') });
  const page = await context.newPage();
  const current = await list(page.request);
  for (const item of [...current.pages, ...current.templates]) {
    if (!item.setting || item.setting.mode === 'public') continue;
    await setVisibility(
      page,
      item.kind === 'page' ? { slug: item.slug! } : { template: item.template! },
      'public',
    );
  }
  await context.close();
});

test('with nothing hidden, every gated route renders as seeded, with no noindex', async ({
  request,
}) => {
  for (const path of GATED) {
    const res = await answer(request, path);
    expect(res.status, path).toBe(200);
    expect(res.headers['x-robots-tag'], path).toBeUndefined();
  }
});

test('hidden with a redirect: a 302 to the right twin, never cached, gone from the lists', async ({
  page,
  request,
}) => {
  await setVisibility(page, { slug: 'about' }, 'hidden', { redirectSlug: 'contact' });
  await until(request, '/about', 302);
  const en = await answer(request, '/about');
  expect(en.headers['location']).toBe('/contact');
  expect(en.headers['cache-control']).toBe('private, no-store');
  expect(en.headers['x-robots-tag']).toBe('noindex');
  expect(en.headers['content-security-policy']).toContain('nonce-');
  expect((await answer(request, '/ar/about')).headers['location']).toBe('/ar/contact');

  const home = await answer(request, '/');
  expect(menuLinks(home.body)).not.toContain('/about');
  expect(menuLinks(home.body)).toContain('/contact');
  expect(menuLinks((await answer(request, '/ar')).body)).not.toContain('/ar/about');
  const sitemap = (await answer(request, '/sitemap.xml')).body;
  expect(sitemap).not.toMatch(/<loc>[^<]*\/about<\/loc>/);
  expect(sitemap).toMatch(/<loc>[^<]*\/contact<\/loc>/);
  expect((await answer(request, '/llms.txt')).body).not.toMatch(/- About: \S+\/about\n/);
});

test('hidden with no redirect: the 404 page, noindex, never cached', async ({ page, request }) => {
  await setVisibility(page, { slug: 'about' }, 'hidden');
  await until(request, '/about', 404);
  const res = await answer(request, '/about');
  expect(res.headers['cache-control']).toBe('private, no-store');
  expect(res.headers['x-robots-tag']).toBe('noindex');
  expect(res.body).toContain('<h1>404</h1>');
  expect((await answer(request, '/ar/about')).status).toBe(404);
});

test('link only: the page renders, noindex, out of the menus and the sitemap', async ({
  page,
  request,
}) => {
  await setVisibility(page, { slug: 'about' }, 'link');
  await until(request, '/about', 200);
  const res = await answer(request, '/about');
  expect(res.headers['x-robots-tag']).toBe('noindex');
  expect(res.headers['cache-control']).toContain('s-maxage');
  expect(menuLinks((await answer(request, '/')).body)).not.toContain('/about');
  expect((await answer(request, '/sitemap.xml')).body).not.toMatch(/<loc>[^<]*\/about<\/loc>/);
});

test('a window of days: hidden inside it, public before and after', async ({ page, request }) => {
  await setVisibility(page, { slug: 'about' }, 'hidden', {
    hideFrom: riyadhDay(2),
    showOn: riyadhDay(5),
  });
  // Saved, and still public today (the window opens the day after tomorrow).
  expect((await answer(request, '/about')).status).toBe(200);
  await setVisibility(page, { slug: 'about' }, 'hidden', {
    hideFrom: riyadhDay(-10),
    showOn: riyadhDay(-5),
  });
  expect((await answer(request, '/about')).status).toBe(200);
  await setVisibility(page, { slug: 'about' }, 'hidden', { hideFrom: riyadhDay(-1) });
  await until(request, '/about', 404);
  await setVisibility(page, { slug: 'about' }, 'public');
  await until(request, '/about', 200);
});

test('a hidden template hides every page it renders, never its listing page', async ({
  page,
  request,
}) => {
  await setVisibility(page, { template: 'service' }, 'hidden');
  await until(request, '/services/logo', 404);
  expect((await answer(request, '/ar/services/logo')).status).toBe(404);
  expect((await answer(request, '/services')).status).toBe(200);
  expect((await answer(request, '/portfolio/the-rider')).status).toBe(200);
  expect((await answer(request, '/sitemap.xml')).body).not.toMatch(/\/services\/logo<\/loc>/);
  await setVisibility(page, { template: 'service' }, 'public');
  await until(request, '/services/logo', 200);
});

test('the homepage is refused, with the words the screen shows', async ({ page }) => {
  const res = await setVisibility(page, { slug: 'home' }, 'hidden', {}, 422);
  expect(await res.json()).toMatchObject({ ok: false, error: 'validation', detail: HOME_REFUSAL });
});

test('the screen: the drawer, the confirm and the toast, with no axe violation open', async ({
  page,
  request,
}) => {
  await page.goto('/admin/visibility', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { level: 1, name: 'Page visibility' })).toBeVisible();
  const row = page.getByRole('button', { name: 'Change who can see Join us', exact: true });
  await expect(row).toBeVisible();
  await expectNoAxe(page, 'the list');

  await row.click();
  const drawer = page.getByRole('dialog', { name: 'Who can see Join us?' });
  await expect(drawer).toBeVisible();
  await drawer.getByRole('radio', { name: /Only people with the link/ }).check();
  await expectNoAxe(page, 'the drawer');
  await drawer.getByRole('radio', { name: /Hidden from the site/ }).check();
  await expect(drawer.getByLabel('Send visitors of the old link to')).toHaveValue(/.+/);
  await expect(drawer.getByLabel('Hide from (optional)')).toBeVisible();
  await expectNoAxe(page, 'the drawer, hidden');
  await drawer.getByRole('radio', { name: /Only people with the link/ }).check();
  await drawer.getByRole('button', { name: 'Apply', exact: true }).click();

  const confirm = page.getByRole('dialog', { name: 'Only people with the link?' });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('This changes the live site within a few minutes.');
  await expectNoAxe(page, 'the confirm');
  await confirm.getByRole('button', { name: 'Apply change' }).click();
  await expect(page.locator('#admin-toasts')).toContainText('Join us is open only to people');
  await expect(page.locator('.vis-row', { hasText: 'Join us' })).toContainText('Link only');
  await until(request, '/join', 200);
  expect((await answer(request, '/join')).headers['x-robots-tag']).toBe('noindex');

  // The homepage's drawer says why its other modes are off.
  await page.getByRole('button', { name: 'Change who can see Home', exact: true }).click();
  const home = page.getByRole('dialog', { name: 'Who can see Home?' });
  await expect(home).toContainText(HOME_REFUSAL);
  await expect(home.getByRole('radio', { name: /Hidden from the site/ })).toBeDisabled();
  await home.getByRole('button', { name: 'Cancel' }).click();

  // And back to everyone.
  await page.getByRole('button', { name: 'Change who can see Join us', exact: true }).click();
  await drawer.getByRole('radio', { name: /Visible to everyone/ }).check();
  await drawer.getByRole('button', { name: 'Apply', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Visible to everyone?' })
    .getByRole('button', {
      name: 'Apply change',
    })
    .click();
  await expect(page.locator('.vis-row', { hasText: 'Join us' })).toContainText('Visible');
});

test.describe('as developer', () => {
  test.use({ storageState: authFile('developer') });

  test('reads the screen and saves through it (RLS agrees since 0057)', async ({ page }) => {
    const current = await list(page.request);
    expect(current.pages.map((p) => p.slug)).toContain('about');
    await setVisibility(page, { slug: 'contact' }, 'link');
    await setVisibility(page, { slug: 'contact' }, 'public');
  });
});

/** Puts one page behind a password (Admin v2 U14b): its own door, never the list's PUT. */
async function setPassword(
  page: Page,
  slug: string,
  password: string,
  note: { en?: string; ar?: string } | null = null,
  expectStatus = 200,
) {
  const current = await list(page.request);
  const item = current.pages.find((p) => p.slug === slug);
  expect(item, slug).toBeTruthy();
  const res = await page.request.post(`${API}/password`, {
    headers: { 'x-csrf-token': await csrf(page), origin: new URL(page.url()).origin },
    data: { pageId: item!.id, password, note, version: item!.setting?.version ?? 0 },
  });
  expect(res.status(), `POST ${API}/password ${slug}: ${await res.text()}`).toBe(expectStatus);
  return { res, pageId: item!.id! };
}

/** Posts the gate's form the way the browser does, and returns the answer unfollowed. */
async function unlock(request: APIRequestContext, origin: string, path: string, password: string) {
  const res = await request.post('/api/page-access', {
    maxRedirects: 0,
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    form: { page: 'about', next: path, password },
  });
  return { status: res.status(), headers: res.headers() };
}

test.describe('behind a password (U14b)', () => {
  const PASSWORD = 'open-sesame-77';
  const NOTE = { en: 'Ask the studio for the password.', ar: 'اطلب كلمة المرور من الاستوديو.' };

  test('the gate, the unlock, and the words that stay closed until it', async ({
    page,
    request,
    browser,
    baseURL,
  }) => {
    const origin = new URL(baseURL!).origin;
    const openHtml = (await answer(request, '/about')).body;
    const { pageId } = await setPassword(page, 'about', PASSWORD, NOTE);
    await until(request, '/about', 403);

    // 1. The gate: a 403 no cache keeps and no crawler indexes, with the admin's message.
    const gate = await answer(request, '/about');
    expect(gate.headers['cache-control']).toBe('private, no-store');
    expect(gate.headers['x-robots-tag']).toBe('noindex');
    expect(gate.headers['content-security-policy']).toContain('nonce-');
    expect(gate.body).toContain(NOTE.en);
    expect(gate.body).toContain('<form method="post" action="/api/page-access">');
    expect(gate.body).not.toContain(PASSWORD);
    // 2. None of the page's own words are in it. Its heading, which only the real page
    //    carries: compared as text, so a gate that leaked the page's markup would fail here.
    const sentence = headingWords(openHtml);
    expect(sentence.length, 'the open page has a heading to compare with').toBeGreaterThan(12);
    expect(wordsOf(gate.body)).not.toContain(sentence);
    // 3. The Arabic twin gets the Arabic gate.
    const ar = await answer(request, '/ar/about');
    expect(ar.status).toBe(403);
    expect(ar.body).toContain('<html lang="ar" dir="rtl">');
    expect(ar.body).toContain(NOTE.ar);

    // 4. Out of the menus, the sitemap and llms.txt, like every page that is not public.
    const home = await answer(request, '/');
    expect(menuLinks(home.body)).not.toContain('/about');
    expect((await answer(request, '/sitemap.xml')).body).not.toMatch(/<loc>[^<]*\/about<\/loc>/);

    // 5. THE FENCE: the public API serves none of its sections either, with the anon key
    //    the browser bundle carries (0061). This is what makes "behind a password" true
    //    rather than a redirect anyone can step around.
    const supabase = (process.env['PUBLIC_SUPABASE_URL'] ?? '').replace(/\/$/, '');
    const anon = process.env['PUBLIC_SUPABASE_ANON_KEY'] ?? '';
    expect(supabase && anon, 'the e2e job names a local Supabase and its anon key').toBeTruthy();
    const fenced = await request.get(
      `${supabase}/rest/v1/page_sections?select=type&page_id=eq.${pageId}`,
      { headers: { apikey: anon, authorization: `Bearer ${anon}` } },
    );
    expect(fenced.status()).toBe(200);
    expect(await fenced.json()).toEqual([]);

    // 6. A wrong password: back to the page, no cookie, nothing typed echoed.
    const wrong = await unlock(request, origin, '/about', 'not-the-password');
    expect(wrong.status).toBe(303);
    expect(wrong.headers['location']).toBe('/about?pa=wrong');
    expect(wrong.headers['set-cookie']).toBeUndefined();
    expect((await answer(request, '/about?pa=wrong')).body).toContain(
      'That password did not work.',
    );

    // 7. The right one, in a context of its own so the cookie is this test's. It stays open
    //    through step 8: that step is about THIS visitor's cookie.
    const visitor = await browser.newContext({ baseURL: baseURL! });
    try {
      const visit = visitor.request;
      const opened = await unlock(visit, origin, '/about', PASSWORD);
      expect(opened.status).toBe(303);
      expect(opened.headers['location']).toBe('/about');
      expect(opened.headers['set-cookie']).toContain('__Host-braiin-pa-');
      expect(opened.headers['set-cookie']).toContain('HttpOnly');
      const unlocked = await answer(visit, '/about');
      expect(unlocked.status).toBe(200);
      // The page renders its own words again, and no cache may keep them.
      expect(wordsOf(unlocked.body)).toContain(sentence);
      // And its images: a section's still is read through the unlocked media reader (0061),
      // so every image the open page showed is on the unlocked one too.
      const images = (html: string) =>
        [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]!);
      expect(images(unlocked.body)).toEqual(expect.arrayContaining(images(openHtml)));
      expect(unlocked.headers['cache-control']).toBe('private, no-store');
      expect(unlocked.headers['x-robots-tag']).toBe('noindex');
      expect(unlocked.headers['cache-tag']).toBeUndefined();
      // The cookie is this page's: another page is unaffected either way.
      expect((await answer(visit, '/contact')).status).toBe(200);

      // 8. A new password ends the old unlock: the visitor who still holds the cookie minted
      //    under the old version is shown the gate again once the edge has the new one.
      await setPassword(page, 'about', 'another-password-9');
      await expect
        .poll(async () => (await answer(visit, '/about')).status, {
          message: 'the old cookie stops opening the page',
          timeout: 75_000,
        })
        .toBe(403);
    } finally {
      await visitor.close();
    }

    // 9. Back to everyone, and the page is itself again.
    await setVisibility(page, { slug: 'about' }, 'public');
    await until(request, '/about', 200);
    expect(wordsOf((await answer(request, '/about')).body)).toContain(sentence);
  });

  test('the gate has no axe violation, in English and in Arabic', async ({
    page,
    browser,
    baseURL,
  }) => {
    await setPassword(page, 'about', PASSWORD, NOTE);
    const visitor = await browser.newContext({ baseURL: baseURL! });
    const visiting = await visitor.newPage();
    for (const path of ['/about', '/ar/about']) {
      await expect
        .poll(async () => (await visiting.goto(path))?.status(), { timeout: 75_000 })
        .toBe(403);
      await expectNoAxe(visiting, `the password gate ${path}`);
    }
    await visitor.close();
    await setVisibility(page, { slug: 'about' }, 'public');
  });

  test('the drawer asks for a password, keeps it out of the markup, and refuses the homepage', async ({
    page,
  }) => {
    // The page's title is the seeded "Contact us" (supabase/seed-data/20-pages.json), and the
    // row button, the drawer and the toast all name it whole.
    await page.goto('/admin/visibility', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Change who can see Contact us', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Who can see Contact us?' });
    await expect(drawer).toBeVisible();
    const apply = drawer.getByRole('button', { name: 'Apply', exact: true });

    await drawer.getByRole('radio', { name: /Behind a password/ }).check();
    // Nothing is pre-filled, and Apply waits for a usable password.
    await expect(drawer.getByLabel('Password', { exact: true })).toHaveValue('');
    await expect(apply).toBeDisabled();
    await drawer.getByLabel('Password', { exact: true }).fill('short7');
    await expect(apply).toBeDisabled();
    await drawer.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await expect(apply).toBeEnabled();
    await drawer.getByLabel('English (optional)').fill(NOTE.en);
    await expectNoAxe(page, 'the drawer, behind a password');
    // Show reveals it on screen; the field is a password field again when pressed back.
    const show = drawer.getByRole('button', { name: 'Show' });
    await show.click();
    await expect(drawer.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');
    await drawer.getByRole('button', { name: 'Hide' }).click();
    await expect(drawer.getByLabel('Password', { exact: true })).toHaveAttribute(
      'type',
      'password',
    );

    await apply.click();
    await page
      .getByRole('dialog', { name: 'Behind a password?' })
      .getByRole('button', { name: 'Apply change' })
      .click();
    await expect(page.locator('#admin-toasts')).toContainText(
      'Contact us now asks for a password.',
    );
    await expect(page.locator('.vis-row', { hasText: 'Contact' })).toContainText('Password');
    // Reopened, the field is empty again: nothing can read a password back (0061).
    await page.getByRole('button', { name: 'Change who can see Contact us', exact: true }).click();
    await expect(drawer.getByLabel('Password', { exact: true })).toHaveValue('');
    await expect(drawer.getByLabel('English (optional)')).toHaveValue(NOTE.en);
    await expect(drawer).toContainText('Setting it again is the only way');
    await drawer.getByRole('button', { name: 'Cancel' }).click();
    // Nowhere in the admin's own HTML, either.
    expect(await page.content()).not.toContain(PASSWORD);

    // The homepage is never offered it.
    await page.getByRole('button', { name: 'Change who can see Home', exact: true }).click();
    const home = page.getByRole('dialog', { name: 'Who can see Home?' });
    await expect(home.getByRole('radio', { name: /Behind a password/ })).toBeDisabled();
    await home.getByRole('button', { name: 'Cancel' }).click();

    // And back to everyone.
    await page.getByRole('button', { name: 'Change who can see Contact us', exact: true }).click();
    await drawer.getByRole('radio', { name: /Visible to everyone/ }).check();
    await drawer.getByRole('button', { name: 'Apply', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Visible to everyone?' })
      .getByRole('button', { name: 'Apply change' })
      .click();
    await expect(page.locator('.vis-row', { hasText: 'Contact' })).toContainText('Visible');
  });

  test('a template is never offered a password, in either layer', async ({ page }) => {
    await page.goto('/admin/visibility', { waitUntil: 'networkidle' });
    await page
      .getByRole('button', { name: 'Change who can see Service page', exact: true })
      .click();
    const drawer = page.getByRole('dialog', { name: 'Who can see Service page?' });
    await expect(drawer.getByRole('radio', { name: /Behind a password/ })).toHaveCount(0);
    await drawer.getByRole('button', { name: 'Cancel' }).click();
  });
});

async function expectNoAxe(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(
    violations.map((v) => `${v.id} [${v.impact ?? 'n/a'}] ${v.nodes.length}x: ${v.help}`),
    label,
  ).toEqual([]);
}
