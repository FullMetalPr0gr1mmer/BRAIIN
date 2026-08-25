import { expect, test } from '@playwright/test';

/*
 * /contact and /ar/contact — the ported design.
 *
 * The page came from a standalone HTML mockup whose form had no honeypot, no consent
 * checkbox, no CSRF-bearing same-origin fetch, and <option> elements with no `value`
 * attribute. Porting that markup naively would have deleted the spam guard and the PDPL
 * lawful basis, and made every submission 422 — on /ar it would have posted Arabic
 * labels into a citext slug column. None of that fails an existing test, so these are
 * the assertions that hold the port honest.
 */

const ROUTES = ['/contact', '/ar/contact'] as const;

const BUDGET_BANDS = ['lt_10k', '10k_50k', '50k_150k', 'gt_150k', 'undisclosed'];
const TIMELINE_BANDS = ['asap', '1_3m', '3_6m', 'flexible'];

for (const route of ROUTES) {
  test.describe(`contact — ${route}`, () => {
    test('the form security surface survived the redesign', async ({ page }) => {
      await page.goto(route, { waitUntil: 'load' });

      // Honeypot: present, unreachable by keyboard, and NOT display:none (bots skip
      // those). It must be offset with a logical property — `left: -9999px` adds ten
      // thousand pixels of horizontal scroll to every RTL page.
      const hp = page.locator('#cf-hp');
      await expect(hp).toHaveCount(1);
      await expect(hp).toHaveAttribute('tabindex', '-1');
      await expect(hp).toHaveAttribute('name', 'hp');

      // PDPL consent: a real checkbox with an associated label. Dropping it fails no
      // other test and silently writes consent_marketing=false forever.
      const consent = page.locator('#cf-consent');
      await expect(consent).toHaveCount(1);
      await expect(consent).toHaveAttribute('type', 'checkbox');
      await expect(page.locator('label[for="cf-consent"]')).toHaveCount(1);

      // novalidate stays: the form does its own messaging in both languages.
      await expect(page.locator('#contact-form')).toHaveAttribute('novalidate', '');

      // The status live region and every branch it can render.
      const status = page.locator('#contact-status');
      await expect(status).toHaveAttribute('role', 'status');
      await expect(status).toHaveAttribute('aria-live', 'polite');
      for (const attr of [
        'data-sending',
        'data-ok',
        'data-invalid',
        'data-unavailable',
        'data-error',
      ]) {
        expect(await status.getAttribute(attr), `${attr} must carry copy`).toBeTruthy();
      }
    });

    test('every select posts a schema value, never a visible label', async ({ page }) => {
      await page.goto(route, { waitUntil: 'load' });

      const values = async (sel: string) =>
        page.$$eval(`${sel} option`, (os) => os.map((o) => o.getAttribute('value')));

      // Empty string is the "no answer" option; everything else must be a slug/enum.
      for (const v of await values('#cf-service')) {
        expect(v, 'service option missing a value attribute').not.toBeNull();
        if (v) expect(v, `service value "${v}" is not a slug`).toMatch(/^[a-z0-9-]+$/);
      }
      for (const v of await values('#cf-budget')) {
        if (v) expect(BUDGET_BANDS, `budget value "${v}"`).toContain(v);
      }
      for (const v of await values('#cf-timeline')) {
        if (v) expect(TIMELINE_BANDS, `timeline value "${v}"`).toContain(v);
      }
    });

    test('company is present, bounded, and autocompletable', async ({ page }) => {
      await page.goto(route, { waitUntil: 'load' });
      const company = page.locator('#cf-company');
      await expect(company).toHaveAttribute('name', 'company');
      await expect(company).toHaveAttribute('maxlength', '120'); // mirrors the Zod cap
      await expect(company).toHaveAttribute('autocomplete', 'organization'); // WCAG 1.3.5
    });

    test('the honeypot does not create horizontal scroll', async ({ page }) => {
      // The RTL half of this is the point: a physically-offset hidden field is invisible
      // on /contact and catastrophic on /ar/contact.
      await page.setViewportSize({ width: 1366, height: 900 });
      await page.goto(route, { waitUntil: 'load' });
      const overflow = await page.evaluate(() => {
        const el = document.scrollingElement!;
        return el.scrollWidth - el.clientWidth;
      });
      expect(overflow, 'page scrolls horizontally').toBeLessThanOrEqual(1);
    });

    test('FAQ is server-rendered and matches its JSON-LD', async ({ page }) => {
      await page.goto(route, { waitUntil: 'load' });

      // Tier A: the answers must be in the HTML, not built by script. The mockup shipped
      // an empty #faqList and filled it from JS — invisible to crawlers and to
      // find-in-page, and a structured-data mismatch against the FAQPage block.
      const visible = await page.$$eval('.faq-item__t', (els) =>
        els.map((e) => (e.textContent ?? '').trim()),
      );
      expect(visible.length).toBeGreaterThanOrEqual(10);

      const ld = await page.$$eval('script[type="application/ld+json"]', (els) =>
        els.map((e) => e.textContent ?? ''),
      );
      const faqBlock = ld.map((t) => JSON.parse(t)).find((n) => n['@type'] === 'FAQPage');
      expect(faqBlock, 'FAQPage JSON-LD missing').toBeTruthy();

      const asked = faqBlock.mainEntity.map((q: { name: string }) => q.name);
      expect(asked.sort()).toEqual(visible.sort());
    });

    test('the FAQ opens without JavaScript', async ({ browser }) => {
      // Native <details>, so the accordion is a progressive-enhancement floor rather
      // than a script dependency.
      const ctx = await browser.newContext({ javaScriptEnabled: false });
      const p = await ctx.newPage();
      await p.goto(route, { waitUntil: 'load' });
      const first = p.locator('.faq-item').first();
      await first.locator('summary').click();
      await expect(first).toHaveAttribute('open', '');
      await expect(first.locator('.faq-item__a p')).toBeVisible();
      await ctx.close();
    });

    test('no inline styles or scripts survived the port', async ({ request }) => {
      // Assert on the SERVED markup, not the live DOM. CSP's style-src governs what the
      // parser sees — `<style>` elements and `style=` attributes in the response — and
      // does not govern CSSOM writes, so the reveal script's runtime
      // `--rv-delay` properties are legitimate and would make a DOM-based check fail
      // for the wrong reason.
      //
      // The mockup was 653 lines of inline <style>, 366 of inline <script>, and a
      // unpkg.com/lenis tag. Any survivor is silently inert under this CSP: the page
      // renders unstyled or the behaviour simply never runs, with only a console entry.
      const html = await (await request.get(route)).text();
      expect(html.match(/<style[\s>]/g) ?? [], 'inline <style> block in the response').toHaveLength(
        0,
      );
      expect(html.match(/\sstyle="/g) ?? [], 'inline style attribute in the response').toHaveLength(
        0,
      );
      expect(html).not.toContain('unpkg.com');
      expect(html).not.toContain('fonts.googleapis.com');
    });
  });
}
