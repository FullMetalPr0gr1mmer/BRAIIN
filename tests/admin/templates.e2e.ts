import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { TENANT_ID } from '../../scripts/gen-seeds.mjs';
import { discardDrafts, publishOwn, savedPattern, systemClient } from './releaseSteps';
import { SKIP_REASON, authFile, releasesOn, staffEnv } from './staff';

/*
 * The template editors (Admin v2 E3), signed in, through the real Worker, session and database,
 * in both modes (Admin v2 R14b: with releases on a save is a pending change, the status says
 * "Saved as an unpublished change", and this spec publishes its own change, the service's or
 * the shared text's, before it reads the public pages; releaseSteps.ts):
 *
 *   Admin          Pages' Templates card opens the Service page template on its first published
 *                  service; Showing lists the services by discipline; the parts are listed, read
 *                  only; zero axe WCAG 2.2 A/AA violations at 1280 (the preview frame included),
 *                  no page or console error, no CSP violation;
 *   the item       "This service" saves the service's tagline with the full editor's own PATCH
 *                  (/api/admin/services/<id>, nothing else), and the service page shows it;
 *   shared text    a line written in English and Arabic is saved through
 *                  /api/admin/template-copy and every service page shows it, server-side, in
 *                  both languages; English alone is refused with the field's error;
 *   Showing        another service: the address and the preview follow;
 *   the project    the Project page template: one flat list, its parts, the project template's
 *                  lines with the built-in words in grey;
 *   per role       Content Creator opens both; SEO, Developer and Sales get the refusal and a
 *                  403 from the pages and from the shared text's API (read and write).
 *
 * Its own project (playwright.config.ts `templates`), after `theme`: the shared text it saves
 * shows on every service page the public specs read. Everything is put back: this run's own
 * unclaimed pending changes are thrown away (releases on), then the tagline, and the
 * template_copy row is removed (no row is the templates as built, byte for byte:
 * tests/render/templatePages.spec.ts).
 */

test.skip(!staffEnv(), SKIP_REASON);
test.describe.configure({ mode: 'serial' });
test.use({ contextOptions: { reducedMotion: 'reduce' } });

const API = '/api/admin/template-copy';
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const FAB = { en: 'Jump to the form', ar: 'انتقل إلى النموذج' };
const TAGLINE = 'A mark that works everywhere, from a sign to a stamp.';

const ids: Record<string, string> = {};
let blurb: unknown = null;

test.beforeAll(async () => {
  if (!staffEnv()) return;
  const svc = systemClient();
  const rows = await svc
    .from('services')
    .select('id,slug,blurb')
    .eq('tenant_id', TENANT_ID)
    .in('slug', ['logo', 'business-cards']);
  expect(rows.error).toBeNull();
  for (const row of (rows.data ?? []) as { id: string; slug: string; blurb: unknown }[]) {
    ids[row.slug] = row.id;
    if (row.slug === 'logo') blurb = row.blurb;
  }
  expect(Object.keys(ids).sort()).toEqual(['business-cards', 'logo']);
});

test.afterAll(async () => {
  if (!staffEnv()) return;
  // Releases on: this run's own unclaimed pending changes first (the system's to clean).
  await discardDrafts([
    { entityType: 'template_copy' },
    ...(ids['logo'] ? [{ entityType: 'service', entityIds: [ids['logo']] }] : []),
  ]);
  const svc = systemClient();
  // The service role, which the release guard lets through (an out-of-band system change).
  await svc.from('template_copy').delete().eq('tenant_id', TENANT_ID);
  if (blurb !== null) await svc.from('services').update({ blurb }).eq('id', ids['logo']!);
});

/** Page and console errors, and CSP violations in the editor and in every frame. */
async function watch(page: Page): Promise<() => Promise<string[]>> {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      w.__csp.push(`${event.violatedDirective} ${event.blockedURI || 'inline'}`);
    });
  });
  return async () => {
    const csp: string[] = [];
    for (const frame of page.frames()) {
      const found = await frame
        .evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])
        .catch(() => [] as string[]);
      csp.push(...found.map((v) => `csp (${frame.url()}): ${v}`));
    }
    return [...problems, ...csp];
  };
}

/** The editor, hydrated, its parts column drawn. */
async function hydrated(page: Page) {
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
  await expect(parts(page).locator('li.pe__row').first()).toBeVisible();
}

const parts = (page: Page) => page.getByRole('complementary', { name: 'Edit', exact: true });
/** A row of the parts column, by the exact text of its name. */
const partRow = (page: Page, name: string) =>
  parts(page)
    .locator('li.pe__row')
    .filter({ has: page.locator(`.pe__name:text-is(${JSON.stringify(name)})`) });
const showing = (page: Page) => page.getByLabel('Showing', { exact: true });
const bothLanguages = (page: Page) =>
  page
    .getByRole('group', { name: 'Editing language' })
    .first()
    .getByRole('radio', { name: 'Both' })
    .check();

/** The writes a step sends to a service, a project or the shared text, as "METHOD /path". */
const WRITTEN = /^\/api\/admin\/(?:services|portfolio|template-copy)(?:\/|$)/;
function writes(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET' && WRITTEN.test(new URL(r.url()).pathname)) {
      seen.push(`${r.method()} ${new URL(r.url()).pathname}`);
    }
  });
  return seen;
}

// "Saved at 14:05", or with releases on "Saved as an unpublished change at 14:05".
const saved = (page: Page) =>
  expect(page.getByRole('status').filter({ hasText: savedPattern() }).first()).toBeVisible();

test.describe('as admin', () => {
  test.use({ storageState: authFile('admin') });

  test('Pages opens the Service page template on its first published service; clean and accessible', async ({
    page,
  }) => {
    test.slow(); // axe at 1280 also scans the public page inside the preview frame (E2).
    const problems = await watch(page);
    await page.goto('/admin/pages', { waitUntil: 'networkidle' });
    const card = page
      .getByRole('region', { name: 'Templates' })
      .getByRole('link', { name: 'Service page', exact: true });
    await expect(card).toHaveAttribute('href', '/admin/pages/template/service');
    await card.click();
    await expect(page).toHaveURL(/\/admin\/pages\/template\/service\?item=/);
    await hydrated(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Service page' })).toBeVisible();

    // Showing: services grouped by discipline, the shown one a published service.
    const groups = await showing(page)
      .locator('optgroup')
      .evaluateAll((els) => els.map((el) => el.getAttribute('label')));
    expect(groups.length).toBeGreaterThan(1);
    expect(groups).toContain('Branding');
    const shown = await showing(page).inputValue();
    expect(page.url()).toContain(`item=${shown}`);

    // The parts, in the page's order, read only (no move, hide or remove).
    for (const name of ['Hero', 'The service', 'The value we add', 'Case study', 'Say hello']) {
      await expect(partRow(page, name)).toHaveCount(1);
    }
    await expect(parts(page).getByRole('button', { name: /move|hide|remove|delete/i })).toHaveCount(
      0,
    );
    await expect(page.getByRole('link', { name: 'Full editor', exact: true })).toHaveAttribute(
      'href',
      `/admin/services/${shown}`,
    );

    // The preview column frames the shown service's page.
    await expect(page.getByRole('region', { name: 'Live preview', exact: true })).toBeVisible();
    await expect
      .poll(() =>
        page
          .frames()
          .some((f) => /^\/admin\/preview\/services\/[^/]+$/.test(new URL(f.url()).pathname)),
      )
      .toBe(true);

    const axe = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual(
      [],
    );
    expect(await problems()).toEqual([]);
  });

  test('“This service” saves the tagline with the full editor’s own PATCH, and the page shows it', async ({
    page,
  }) => {
    await page.goto(`/admin/pages/template/service?item=${ids['logo']}`, {
      waitUntil: 'networkidle',
    });
    await hydrated(page);
    await expect(showing(page)).toHaveValue(ids['logo']!);
    await expect(partRow(page, 'This service')).toHaveAttribute('aria-current', 'true');
    await expect(page.getByRole('heading', { level: 2, name: 'This service' })).toBeVisible();

    const sent = writes(page);
    await page.locator('#f-blurb-en').fill(TAGLINE);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await saved(page);
    if (releasesOn()) {
      // The editor also saves by itself when focus leaves the field (P-5): every write is the
      // full editor's own PATCH, and nothing else.
      expect(new Set(sent)).toEqual(new Set([`PATCH /api/admin/services/${ids['logo']}`]));
    } else {
      expect(sent).toEqual([`PATCH /api/admin/services/${ids['logo']}`]);
    }
    // Releases on: the service's own change goes live before its page is read.
    await publishOwn(page, [{ entityType: 'service', entityIds: [ids['logo']!] }]);

    const html = await (await page.request.get('/services/logo')).text();
    expect(html).toContain(TAGLINE);
  });

  test('“Shared text”: Arabic is required; a line in both shows on every service page, in both languages', async ({
    page,
  }) => {
    await page.goto(`/admin/pages/template/service?item=${ids['logo']}`, {
      waitUntil: 'networkidle',
    });
    await hydrated(page);
    await partRow(page, 'Shared text').locator('button.pe__pick').click();
    await expect(page.getByRole('heading', { level: 2, name: 'Shared text' })).toBeVisible();
    await expect(partRow(page, 'Shared text')).toHaveAttribute('aria-current', 'true');
    await bothLanguages(page);

    // The built-in words are each line's placeholder, in grey; the field itself is empty.
    const fabEn = page.locator('#f-service-fab-en');
    const fabAr = page.locator('#f-service-fab-ar');
    await expect(fabEn).toHaveValue('');
    await expect(fabEn).toHaveAttribute('placeholder', 'Skip to inquiry');
    await expect(fabAr).toHaveAttribute('placeholder', 'انتقل للطلب');

    const sent = writes(page);
    // English alone: the server refuses it (Arabic is required), and nothing is stored.
    await fabEn.fill(FAB.en);
    await page.getByRole('button', { name: 'Save shared text' }).click();
    await expect(page.locator('.f__err').first()).toBeVisible();
    const before = await page.request.get(API);
    expect(before.status()).toBe(200);
    expect(((await before.json()) as { data: { service: object } }).data.service).toEqual({});

    await fabAr.fill(FAB.ar);
    await page.getByRole('button', { name: 'Save shared text' }).click();
    await saved(page);
    expect(new Set(sent)).toEqual(new Set([`PATCH ${API}`]));
    const row = ((await (await page.request.get(API)).json()) as { data: Record<string, unknown> })
      .data;
    expect(row['service']).toEqual({ fab: FAB });
    expect(row['project']).toEqual({});
    // Releases on: the shared text goes live before the service pages are read.
    await publishOwn(page, [{ entityType: 'template_copy' }]);

    for (const slug of ['logo', 'business-cards']) {
      const en = await (await page.request.get(`/services/${slug}`)).text();
      expect(en, slug).toContain(`<span>${FAB.en}</span>`);
      expect(en, slug).not.toContain('<span>Skip to inquiry</span>');
      const ar = await (await page.request.get(`/ar/services/${slug}`)).text();
      expect(ar, slug).toContain(`<span>${FAB.ar}</span>`);
    }

    // The preview shows the saved line too.
    const frame = page.frameLocator('iframe[title^="Live preview of"]');
    await expect(frame.getByText(FAB.en, { exact: true }).first()).toBeAttached();
  });

  test('Showing another service: the address and the preview follow; the shared text stays', async ({
    page,
  }) => {
    await page.goto(`/admin/pages/template/service?item=${ids['logo']}`, {
      waitUntil: 'networkidle',
    });
    await hydrated(page);
    await partRow(page, 'Shared text').locator('button.pe__pick').click();
    await showing(page).selectOption(ids['business-cards']!);
    await expect(page).toHaveURL(new RegExp(`item=${ids['business-cards']}`));
    await expect(page.getByRole('heading', { level: 2, name: 'Shared text' })).toBeVisible();
    await expect
      .poll(() =>
        page
          .frames()
          .some((f) => new URL(f.url()).pathname === '/admin/preview/services/business-cards'),
      )
      .toBe(true);
  });

  test('the Project page template: one flat list, its parts, its own lines', async ({ page }) => {
    await page.goto('/admin/pages', { waitUntil: 'networkidle' });
    await page
      .getByRole('region', { name: 'Templates' })
      .getByRole('link', { name: 'Project page', exact: true })
      .click();
    await expect(page).toHaveURL(/\/admin\/pages\/template\/project/);
    await hydrated(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Project page' })).toBeVisible();
    await expect(showing(page).locator('optgroup')).toHaveCount(0);
    expect(await showing(page).locator('option').count()).toBeGreaterThan(1);
    for (const name of ['Banner', 'Overview', 'Breakdown', 'Gallery', 'Next project']) {
      await expect(partRow(page, name)).toHaveCount(1);
    }
    await partRow(page, 'Shared text').locator('button.pe__pick').click();
    await expect(page.locator('#f-project-nextProject-en')).toHaveAttribute(
      'placeholder',
      'Next project',
    );
    await expect(page.locator('#f-service-fab-en')).toHaveCount(0);
  });
});

test.describe('as content_creator', () => {
  test.use({ storageState: authFile('content_creator') });

  test('opens both editors and reads the shared text', async ({ page }) => {
    for (const kind of ['service', 'project']) {
      const res = await page.goto(`/admin/pages/template/${kind}`, { waitUntil: 'networkidle' });
      expect(res?.status(), kind).toBe(200);
      await hydrated(page);
    }
    expect((await page.request.get(API)).status()).toBe(200);
  });
});

for (const role of ['seo', 'developer', 'sales'] as const) {
  test.describe(`as ${role}`, () => {
    test.use({ storageState: authFile(role) });

    test('the template editors and the shared text are refused by the server', async ({ page }) => {
      for (const kind of ['service', 'project']) {
        const res = await page.goto(`/admin/pages/template/${kind}`);
        expect(res?.status(), `${kind} as ${role}`).toBe(403);
        await expect(page.locator('main .msg[data-kind="error"]').first()).toContainText(
          'Your role does not allow that.',
        );
        await expect(
          page.locator('astro-island[component-url*="AdminTemplateEditor"]'),
        ).toHaveCount(0);
      }
      const read = await page.request.get(API);
      expect(read.status(), `GET ${API} as ${role}`).toBe(403);
      expect(await read.json()).toMatchObject({ ok: false, error: 'forbidden' });

      await page.goto('/admin', { waitUntil: 'networkidle' });
      const token = await page.locator('meta[name="csrf-token"]').getAttribute('content');
      const write = await page.request.patch(API, {
        headers: { 'x-csrf-token': token ?? '', origin: new URL(page.url()).origin },
        data: { service: { fab: FAB }, version: 1 },
      });
      expect(write.status(), `PATCH ${API} as ${role}`).toBe(403);
    });
  });
}

test.describe('signed out', () => {
  test('the editors send a visitor to sign in; the API answers 401', async ({ page }) => {
    await page.goto('/admin/pages/template/service');
    expect(new URL(page.url()).pathname).toBe('/admin/login');
    const res = await page.request.get(API);
    expect(res.status()).toBe(401);
  });
});
