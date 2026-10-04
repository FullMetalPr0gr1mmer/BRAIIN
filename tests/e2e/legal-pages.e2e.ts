import { expect, test } from '@playwright/test';

/*
 * The privacy notice sends rights requests to the site's contact address (design-port J-17).
 *
 * The production defect this guards (found 2026-10-03): both rights lines — the DSAR line
 * and the Join recruitment section, EN + AR — named a hardcoded mailbox on a one-i domain
 * the studio never registered, so a request bounced, and whoever registered the domain
 * would have received them. The address is now the Site profile's `contact_email`, the
 * same one the footer shows, so the two can never disagree: this reads the footer's link
 * and holds the notice to it, whatever the database says.
 */

for (const path of ['/privacy', '/ar/privacy']) {
  test(`${path}: both rights lines link the footer's contact address`, async ({ page }) => {
    const res = await page.goto(path);
    expect(res?.status()).toBe(200);

    const footer = page.locator('.site-footer__mail');
    await expect(footer).toHaveCount(1);
    const href = await footer.getAttribute('href');
    expect(href).toMatch(/^mailto:[^@\s]+@[^@\s]+$/);
    const address = href!.slice('mailto:'.length);

    const links = page.locator('main a[href^="mailto:"]');
    await expect(links).toHaveCount(2);
    for (const link of await links.all()) {
      await expect(link).toHaveAttribute('href', href!);
      // An address must not be re-ordered inside RTL text (the footer's rule).
      await expect(link).toHaveAttribute('dir', 'ltr');
      expect((await link.textContent())?.trim()).toBe(address);
    }
    // One of them in the section the Join form's consent links to.
    await expect(page.locator('#recruitment a[href^="mailto:"]')).toHaveCount(1);
  });
}
