import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { RELEASES_OFF_ONLY, SKIP_REASON, authFile, releasesOn, staffEnv } from './staff';

/*
 * The theme (Admin v2 E4, AV-27), end to end through the real Worker, session and database,
 * releases off (a save is live):
 *   - the editor names a failing pair in words and offers a colour that passes; the server
 *     refuses the failing theme (422) whatever the screen does; zero axe violations, the error
 *     on screen included;
 *   - Simple mode: a swatch whose palette fails, the darker main colour the screen offers,
 *     calmer motion; the admin previews it on itself (the CSSOM) and saves it;
 *   - the site wears it: every page links /styles/theme.css?v=<hash> (immutable, tagged
 *     site:chrome, custom properties only), a visitor's page draws the colour, with zero axe
 *     and CSP violations in either language; the admin wears it too;
 *   - Reset to brand defaults (a danger confirm) puts the brand back and no page links it;
 *   - shapes and type (E12, AV-32): square corners and buttons, Bold headings as written; the
 *     sample draws them, the stylesheet carries their four tokens, a visitor's page wears them
 *     (a square consent button, a Bold hero heading as written) and the Arabic page preloads
 *     the 700 face its Bold heading renders in, with zero axe and CSP violations;
 *   - a Developer edits it (theme.edit) and is refused a failing palette (422, the pair named);
 *     a v1 save (E4's editor, during a deploy) is still taken, and stored as v2.
 *
 * Its own project (playwright.config.ts `theme`), alone, after `ga4` and before `maintenance`:
 * a saved theme changes every public page the other specs read. The brand's own settings are
 * put back afterwards whatever happened (no token, so no page links a stylesheet).
 */

test.skip(!staffEnv(), SKIP_REASON);
// The release-mode rehearsal (Admin v2 R14-prep): written for releases off.
test.skip(releasesOn(), RELEASES_OFF_ONLY);
test.describe.configure({ mode: 'serial' });

const SCREEN = '/admin/appearance/theme';
const API = '/api/admin/themes';
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const BRAND_SHAPES = { corners: 'brand', buttons: 'pill' };
const BRAND_TYPE = { headingWeight: 800, headingCase: 'uppercase' };
// The brand's own theme as the editor saves it since E12 (v2), and as E4's editor did (v1),
// which the server still takes and stores as v2 at the brand's shapes and type.
const BRAND = {
  v: 2,
  mode: 'simple',
  colors: { primary: '#0024BC', hover: '#024CFF', accent: '#22A9FF' },
  motion: { marquee: 'normal', reveal: true },
  shapes: BRAND_SHAPES,
  type: BRAND_TYPE,
};
const BRAND_V1 = { v: 1, mode: BRAND.mode, colors: BRAND.colors, motion: BRAND.motion };
// Any link to the theme stylesheet, whatever its attribute order and address: its shape (the
// body's hash, E4-SEC-1) is asserted on its own, so a wrong address fails there instead of
// matching nothing here (the old `v=(\d+)` matched no hash, so "no link" passed for any page).
const LINK = /<link\b[^>]*\bhref="(\/styles\/theme\.css\?v=[^"]*)"[^>]*>/g;

type Row = Record<string, unknown> & { id: string; version: number };

async function csrf(page: Page): Promise<string> {
  if (!page.url().includes('/admin')) await page.goto('/admin', { waitUntil: 'networkidle' });
  const token = await page.locator('meta[name="csrf-token"]').getAttribute('content');
  expect(token, 'the admin layout carries a CSRF token').toBeTruthy();
  return token!;
}

/** The tenant's v1 theme (the row with settings), or null before the first save. */
async function theme(page: Page): Promise<Row | null> {
  const list = await page.request.get(API);
  expect(list.status(), await list.text()).toBe(200);
  for (const { id } of ((await list.json()) as { data: { rows: { id: string }[] } }).data.rows) {
    const one = await page.request.get(`${API}/${id}`);
    expect(one.status()).toBe(200);
    const row = ((await one.json()) as { data: Row }).data;
    if (row['settings']) return row;
  }
  return null;
}

/** Saves settings as the page's person, through the route (live: releases are off). */
async function save(page: Page, settings: unknown, status = 200) {
  const headers = { 'x-csrf-token': await csrf(page), origin: new URL(page.url()).origin };
  const row = await theme(page);
  const res = row
    ? await page.request.patch(`${API}/${row.id}`, {
        headers,
        data: { settings, version: row.version },
      })
    : await page.request.post(API, { headers, data: { settings } });
  expect(res.status(), await res.text()).toBe(status);
  return res;
}

/** The brand's own theme, as a person with theme.edit (Admin) saves it. */
async function putBrandBack(browser: Browser) {
  const context = await browser.newContext({ storageState: authFile('admin') });
  const page = await context.newPage();
  try {
    await page.goto('/admin', { waitUntil: 'networkidle' });
    await save(page, BRAND);
  } finally {
    await context.close();
  }
}

/** The font preloads a public page's markup carries (the hrefs, in order). */
async function fontPreloadsOn(page: Page, path: string): Promise<string[]> {
  const res = await page.request.get(path);
  expect(res.status(), path).toBe(200);
  return [...(await res.text()).matchAll(/<link\b[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => /\brel="preload"/.test(tag) && /\bas="font"/.test(tag))
    .map((tag) => /\bhref="([^"]*)"/.exec(tag)?.[1] ?? '');
}

/** The theme links a public page carries (the address and its version). */
async function linksOn(page: Page, path: string): Promise<string[]> {
  const res = await page.request.get(path);
  expect(res.status(), path).toBe(200);
  return [...(await res.text()).matchAll(LINK)].map((m) => m[1]!);
}

// The first save creates the tenant's theme (the brand's own: no token, no link), so each test
// below edits one, on a first run or a retry alike; and the brand is put back at the end.
test.beforeAll(async ({ browser }) => putBrandBack(browser));
test.afterAll(async ({ browser }) => putBrandBack(browser));

test.describe('as admin', () => {
  test.use({ storageState: authFile('admin'), contextOptions: { reducedMotion: 'reduce' } });

  test('the gate names the pair and offers a colour; the server refuses; axe clean', async ({
    page,
  }) => {
    await page.goto(SCREEN, { waitUntil: 'networkidle' });
    for (const name of [
      'Brand colours',
      'Shapes',
      'Typography',
      'Motion',
      'What stays the same',
      'Preview',
    ]) {
      await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
    }
    expect((await new AxeBuilder({ page }).withTags(WCAG).analyze()).violations).toEqual([]);

    await page
      .getByRole('group', { name: 'How do you want to set colours?', exact: true })
      .getByRole('radio', { name: 'Advanced: every colour', exact: true })
      .check();
    await page.locator('#theme-hover').fill('#7FB2FF');
    const alert = page
      .getByRole('alert')
      .filter({ hasText: 'These colours are hard to read, so the theme cannot be saved yet.' });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(
      /White text on Hover is \d+\.\d:1, needs 4\.5:1 \(white text on a hovered button\)\./,
    );
    const axe = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual(
      [],
    );

    // Saved anyway: the server refuses it, and the theme stays as it was.
    const before = await theme(page);
    const [refused] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(API) && r.request().method() === 'PATCH'),
      page.getByRole('button', { name: 'Save theme', exact: true }).click(),
    ]);
    expect(refused.status()).toBe(422);
    expect(await refused.text()).toContain('White text on Hover is');
    expect((await theme(page))?.['settings']).toEqual(before?.['settings']);

    // The colour the screen offers passes.
    await page.getByRole('button', { name: /^Use #[0-9A-F]{6} for Hover instead$/ }).click();
    await expect(alert).toHaveCount(0);
  });

  test('Simple: a swatch, the shade that passes, calmer motion; the site and the admin wear it', async ({
    page,
    browser,
  }) => {
    await page.goto(SCREEN, { waitUntil: 'networkidle' });
    await page
      .getByRole('group', { name: 'How do you want to set colours?', exact: true })
      .getByRole('radio', { name: 'Simple: one colour', exact: true })
      .check();
    // A swatch whose generated palette fails (Hover too light for white text).
    await page
      .getByRole('group', { name: 'Main colour: suggested colours', exact: true })
      .getByRole('button', { name: '#0B6EB0', exact: true })
      .click();
    const alert = page.getByRole('alert').filter({ hasText: 'hard to read' });
    await expect(alert).toBeVisible();
    const offer = page.getByRole('button', {
      name: /^Use #[0-9A-F]{6} as the main colour instead$/,
    });
    await expect(offer).toBeVisible();
    const main = /#[0-9A-F]{6}/.exec((await offer.textContent()) ?? '')![0];
    await offer.click();
    await expect(alert).toHaveCount(0);
    await expect(page.locator('#theme-primary')).toHaveValue(main);
    const hex = main.toLowerCase();

    await page
      .getByRole('group', { name: 'Clients marquee speed', exact: true })
      .getByRole('radio', { name: 'Much slower', exact: true })
      .check();
    await page
      .getByRole('group', { name: 'Sections', exact: true })
      .getByRole('radio', { name: 'Show at once', exact: true })
      .check();

    // The admin previews the passing colours on itself (style.setProperty on <html>).
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.style.getPropertyValue('--bs-klein')),
      )
      .toBe(hex);

    const [saved] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(API) && r.request().method() === 'PATCH'),
      page.getByRole('button', { name: 'Save theme', exact: true }).click(),
    ]);
    expect(saved.status(), await saved.text()).toBe(200);
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: /Saved at \d\d:\d\d/ })
        .first(),
    ).toBeVisible();
    const row = (await theme(page))!;
    expect(row['settings']).toEqual({
      v: 2,
      mode: 'simple',
      colors: expect.objectContaining({ primary: main }),
      motion: { marquee: 'slowest', reveal: false },
      shapes: BRAND_SHAPES,
      type: BRAND_TYPE,
    });

    // Every page links the live version, once, in either language.
    const [en] = await linksOn(page, '/');
    if (en === undefined) {
      // Say why, in the CI log: the row as staff read it, how the page was cached (a failed
      // theme read makes it no-store), and what the stylesheet route itself answers.
      const home = await page.request.get('/');
      const sheet = await page.request.get('/styles/theme.css');
      const tokens = row['tokens'];
      // The theme as a visitor's key reads it (the Worker's contentClient), and every row as
      // the service role sees it: a policy or a second row would show here.
      const env = staffEnv()!;
      const anonKey = process.env['PUBLIC_SUPABASE_ANON_KEY'] ?? '';
      const asAnon = anonKey
        ? await createClient(env.url, anonKey, { auth: { persistSession: false } })
            .from('custom_themes')
            .select('tokens')
            .limit(2)
        : null;
      const all = await createClient(env.url, env.serviceKey, { auth: { persistSession: false } })
        .from('custom_themes')
        .select('id,tenant_id,is_active,settings,tokens');
      throw new Error(
        `no theme link on /: ${JSON.stringify({
          isActive: row['isActive'] ?? row['is_active'],
          tokenKeys: tokens && typeof tokens === 'object' ? Object.keys(tokens).length : tokens,
          homeCache: home.headers()['cache-control'],
          sheetStatus: sheet.status(),
          sheetCache: sheet.headers()['cache-control'],
          sheetBody: (await sheet.text()).slice(0, 120),
          anonKeySet: anonKey !== '',
          anonRows: asAnon?.data?.length ?? null,
          anonError: asAnon?.error?.message ?? null,
          anonTokenKeys: (asAnon?.data ?? []).map((r) =>
            r.tokens && typeof r.tokens === 'object' ? Object.keys(r.tokens).length : r.tokens,
          ),
          allRows: (all.data ?? []).map((r) => ({
            tenant: String(r.tenant_id).slice(0, 8),
            active: r.is_active,
            v1: r.settings !== null,
            tokenKeys: r.tokens && typeof r.tokens === 'object' ? Object.keys(r.tokens).length : 0,
          })),
          allError: all.error?.message ?? null,
        })}`,
      );
    }
    expect(await linksOn(page, '/')).toHaveLength(1);
    expect(await linksOn(page, '/ar/')).toEqual([en]);
    // The address names the hash of the body, never the row's version (E4-SEC-1).
    expect(en).toMatch(/^\/styles\/theme\.css\?v=[0-9a-f]{16}$/);
    const sheet = await page.request.get(en!);
    expect(sheet.status()).toBe(200);
    expect(sheet.headers()['content-type']).toBe('text/css; charset=utf-8');
    expect(sheet.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(sheet.headers()['cache-tag']).toBe('site:chrome');
    const css = await sheet.text();
    expect(css).toMatch(/^:root\{(--bs-[a-z-]+:[^;{}<>]+;)+\}\n$/);
    expect(css).toContain(`--bs-klein:${hex};`);
    expect(css).toContain('--bs-marquee-scale:2.5;');
    expect(css).toContain('--bs-rv-from:1;--bs-rv-shift:0px;');

    // A visitor's page draws it: zero axe and CSP violations, in both languages.
    const visitor = await browser.newContext({ reducedMotion: 'reduce' });
    await visitor.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __csp: string[] }).__csp = seen;
      document.addEventListener('securitypolicyviolation', (e) => {
        seen.push(`${e.disposition} ${e.violatedDirective} ${e.blockedURI}`);
      });
    });
    try {
      const site = await visitor.newPage();
      for (const path of ['/', '/ar/', '/services/logo', '/contact']) {
        await site.goto(path, { waitUntil: 'load' });
        await expect
          .poll(() =>
            site.evaluate(() =>
              getComputedStyle(document.documentElement).getPropertyValue('--bs-klein').trim(),
            ),
          )
          .toBe(hex);
        const found = await new AxeBuilder({ page: site }).withTags(WCAG).analyze();
        expect(
          found.violations.map((v) => `${path} ${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`),
        ).toEqual([]);
        expect(await site.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual(
          [],
        );
      }
    } finally {
      await visitor.close();
    }

    // The admin wears it too: admin.css reads --bs-klein first.
    await page.goto(SCREEN, { waitUntil: 'networkidle' });
    await expect(page.locator(`link[rel="stylesheet"][href="${en}"]`)).toHaveCount(1);
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--ad-primary').trim(),
      ),
    ).toBe(hex);
    // And the form shows the theme it saved, not the brand's.
    await expect(page.locator('#theme-primary')).toHaveValue(main);
    await expect(
      page
        .getByRole('group', { name: 'Clients marquee speed', exact: true })
        .getByRole('radio', { name: 'Much slower', exact: true }),
    ).toBeChecked();
  });

  test('Shapes and type: square, Bold, as written; the sample, the stylesheet and the site follow', async ({
    page,
    browser,
  }) => {
    await page.goto(SCREEN, { waitUntil: 'networkidle' });
    const pick = (group: string, option: string) =>
      page
        .getByRole('group', { name: group, exact: true })
        .getByRole('radio', { name: option, exact: true })
        .check();
    await pick('Corners', 'Square');
    await pick('Buttons', 'Square');
    await pick('Heading weight', 'Bold');
    await pick('Heading case', 'As written');
    // The sample draws them (SVG attributes, no style).
    const sample = page.getByRole('img', { name: /^A sample of the site in this theme/ });
    await expect(sample).toHaveAttribute('data-corners', 'square');
    await expect(sample).toHaveAttribute('data-buttons', 'square');
    await expect(sample).toHaveAttribute('data-weight', '700');
    await expect(sample).toHaveAttribute('data-case', 'as-written');
    expect((await new AxeBuilder({ page }).withTags(WCAG).analyze()).violations).toEqual([]);

    const [saved] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(API) && r.request().method() === 'PATCH'),
      page.getByRole('button', { name: 'Save theme', exact: true }).click(),
    ]);
    expect(saved.status(), await saved.text()).toBe(200);
    const row = (await theme(page))!;
    expect(row['settings']).toMatchObject({
      v: 2,
      shapes: { corners: 'square', buttons: 'square' },
      type: { headingWeight: 700, headingCase: 'as-written' },
    });

    // The stylesheet carries the four tokens, last, in their fixed order.
    const links = await linksOn(page, '/');
    expect(links, 'the home page links the theme').toHaveLength(1);
    const sheet = await page.request.get(links[0]!);
    expect(sheet.status()).toBe(200);
    expect(await sheet.text()).toMatch(
      /;--bs-radius-scale:0;--bs-btn-radius:0px;--bs-heading-weight:700;--bs-heading-case:none;\}\n$/,
    );

    // The Arabic page preloads the face its Bold heading renders in; English keeps Archivo.
    const ar = await fontPreloadsOn(page, '/ar/');
    expect(ar, 'the Arabic page preloads one font').toHaveLength(1);
    expect(ar).toEqual(['/fonts/almarai-700-arabic.woff2']);
    expect(await fontPreloadsOn(page, '/')).toEqual(['/fonts/archivo-var-latin.woff2']);

    // A visitor's page wears them, with zero axe and CSP violations, in both languages.
    const visitor = await browser.newContext({ reducedMotion: 'reduce' });
    await visitor.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __csp: string[] }).__csp = seen;
      document.addEventListener('securitypolicyviolation', (e) => {
        seen.push(`${e.disposition} ${e.violatedDirective} ${e.blockedURI}`);
      });
    });
    try {
      const site = await visitor.newPage();
      for (const path of ['/', '/ar/']) {
        await site.goto(path, { waitUntil: 'load' });
        const read = () =>
          site.evaluate(() => {
            const h1 = document.querySelector('.hero h1');
            const button = document.querySelector('.consent-actions button');
            if (!h1 || !button) return null;
            return {
              weight: getComputedStyle(h1).fontWeight,
              case: getComputedStyle(h1).textTransform,
              button: getComputedStyle(button).borderTopLeftRadius,
            };
          });
        await expect.poll(read).not.toBeNull();
        await expect.poll(read).toEqual({ weight: '700', case: 'none', button: '0px' });
        const found = await new AxeBuilder({ page: site }).withTags(WCAG).analyze();
        expect(
          found.violations.map((v) => `${path} ${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`),
        ).toEqual([]);
        expect(await site.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual(
          [],
        );
      }
    } finally {
      await visitor.close();
    }

    // The form shows what it saved.
    await page.goto(SCREEN, { waitUntil: 'networkidle' });
    await expect(
      page
        .getByRole('group', { name: 'Heading weight', exact: true })
        .getByRole('radio', { name: 'Bold', exact: true }),
    ).toBeChecked();
    await expect(
      page
        .getByRole('group', { name: 'Corners', exact: true })
        .getByRole('radio', { name: 'Square', exact: true }),
    ).toBeChecked();
  });

  test('Reset to brand defaults: a danger confirm, then no page links a theme', async ({
    page,
  }) => {
    await page.goto(SCREEN, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Reset to brand defaults', exact: true }).click();
    const ask = page.getByRole('dialog').filter({ hasText: 'Reset the theme?' });
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: 'Reset', exact: true }).click();
    await expect(ask).toBeHidden();
    await expect(page.locator('#theme-primary')).toHaveValue('#0024BC');
    const [saved] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(API) && r.request().method() === 'PATCH'),
      page.getByRole('button', { name: 'Save theme', exact: true }).click(),
    ]);
    expect(saved.status(), await saved.text()).toBe(200);
    expect((await theme(page))?.['settings']).toEqual(BRAND);
    expect(await linksOn(page, '/')).toEqual([]);
    // No theme: the Arabic page preloads its own face again.
    expect(await fontPreloadsOn(page, '/ar/')).toEqual(['/fonts/almarai-800-arabic.woff2']);
    expect(await linksOn(page, '/ar/')).toEqual([]);
    // A theme's address answers the (empty) current theme, never stored (CR2); a bare one is
    // no address at all.
    const sheet = await page.request.get('/styles/theme.css?v=0000000000000000');
    expect(await sheet.text()).toBe('');
    expect(sheet.headers()['cache-control']).toBe('no-store');
    const bare = await page.request.get('/styles/theme.css');
    expect(await bare.text()).toBe('');
    expect(bare.headers()['cache-control']).toBe('no-store');
    await page.goto(SCREEN, { waitUntil: 'networkidle' });
    await expect(page.locator('link[href^="/styles/theme.css"]')).toHaveCount(0);
  });
});

test.describe('as developer', () => {
  test.use({ storageState: authFile('developer'), contextOptions: { reducedMotion: 'reduce' } });

  test('edits the theme (theme.edit), and the server refuses a failing palette', async ({
    page,
  }) => {
    await page.goto(SCREEN, { waitUntil: 'networkidle' });
    await expect(
      page.getByRole('heading', { level: 2, name: 'Brand colours', exact: true }),
    ).toBeVisible();
    const refused = await save(
      page,
      { ...BRAND, colors: { ...BRAND.colors, hover: '#7FB2FF' } },
      422,
    );
    expect(await refused.text()).toContain('White text on Hover is');
    await save(page, { ...BRAND, motion: { marquee: 'slower', reveal: true } });
    expect((await theme(page))?.['settings']).toMatchObject({ motion: { marquee: 'slower' } });
    // E4's v1 shape is still taken (a deploy's old editor), and stored as v2.
    await save(page, BRAND_V1);
    expect((await theme(page))?.['settings']).toEqual(BRAND);
  });
});
