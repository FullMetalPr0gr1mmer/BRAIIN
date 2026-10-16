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
  mode: 'public' | 'hidden' | 'link';
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
  await expect(confirm).toContainText('This changes the live site within a minute.');
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

async function expectNoAxe(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(
    violations.map((v) => `${v.id} [${v.impact ?? 'n/a'}] ${v.nodes.length}x: ${v.help}`),
    label,
  ).toEqual([]);
}
