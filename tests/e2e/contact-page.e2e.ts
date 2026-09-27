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

// The UI v2 bands (packages/schemas/lead.ts BUDGET_BANDS) — the form offers only these.
const BUDGET_BANDS = ['lt_25k', '25k_75k', '75k_200k', 'gt_200k', 'not_sure'];

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
      const budgets = await values('#cf-budget');
      expect(budgets, 'the design’s bands, after the empty "Prefer to discuss"').toEqual([
        '',
        ...BUDGET_BANDS,
      ]);
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

// ── UI v2 PR9: the ported contact page ────────────────────────────────────────────────
// Verified on production before the port: the hero rendered the HOME headline and its
// "See our work" button, the page had no <main>, the FAQ sat on a paper band where its sky
// kicker and accent measured 2.56:1, and the Arabic FAQ was an MSA rewrite.

const PAGE = {
  '/contact': {
    h1: "Let's make it happen",
    sub: "Strategy, creative, and production under one roof. Tell us where you want to go, and we'll take it from there.",
    cta: 'Start your project',
    inquiry: "Tell us what you're making",
    touch: 'Talk to us',
    faq: 'Questions we get every week',
    firstQ: 'What does a full brand identity include?',
    submit: 'Send a message',
    ok: "Got it. We'll be in touch within one business day.",
    budgets: [
      'Under 25k SAR',
      '25k to 75k SAR',
      '75k to 200k SAR',
      '200k SAR and up',
      'Not sure yet',
    ],
    locale: 'en',
  },
  '/ar/contact': {
    h1: 'خلّنا نحقّقها',
    sub: 'استراتيجية وإبداع وإنتاج تحت سقف واحد. قل لنا وين تبي توصل، والباقي علينا.',
    cta: 'ابدأ مشروعك',
    inquiry: 'قل لنا وش تصنع',
    touch: 'كلّمنا مباشرة',
    faq: 'أسئلة توصلنا كل أسبوع',
    firstQ: 'وش تشمل الهوية البصرية الكاملة؟',
    submit: 'أرسل رسالتك',
    ok: 'وصلتنا. بنتواصل معك خلال يوم عمل واحد.',
    budgets: [
      'أقل من ٢٥ ألف ريال',
      '٢٥ إلى ٧٥ ألف ريال',
      '٧٥ إلى ٢٠٠ ألف ريال',
      '٢٠٠ ألف ريال فأكثر',
      'لسه ما حددنا',
    ],
    locale: 'ar',
  },
} as const;

/** WCAG contrast of every kicker and heading accent against the band it sits on. */
function accentContrasts() {
  const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  const lum = (v: number[]) => {
    const ch = (x: number) => {
      const s = x / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * ch(v[0] ?? 0) + 0.7152 * ch(v[1] ?? 0) + 0.0722 * ch(v[2] ?? 0);
  };
  const bandBg = (el: Element) => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      const bg = getComputedStyle(n).backgroundColor;
      if (!/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) return bg;
    }
    return 'rgb(255, 255, 255)';
  };
  const els = document.querySelectorAll(
    'main section .tag > span:last-child, main .sec-head h2 em',
  );
  return [...els].map((el) => {
    const a = lum(rgb(getComputedStyle(el).color));
    const b = lum(rgb(bandBg(el)));
    return {
      text: (el.textContent ?? '').trim(),
      ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
    };
  });
}

const SCHEMA_KEYS = [
  'kind',
  'locale',
  'name',
  'email',
  'company',
  'message',
  'serviceOfInterest',
  'budgetBand',
  'timelineText',
  'consentMarketing',
  'hp',
];

for (const route of ROUTES) {
  const t = PAGE[route];

  test.describe(`contact (UI v2) — ${route}`, () => {
    test('one <main>, opening with the contact banner — not the home hero', async ({ page }) => {
      await page.goto(route);
      await expect(page.locator('main')).toHaveCount(1);
      const hero = page.locator('main > .hero');
      await expect(hero).toHaveClass(/hero--banner/);
      await expect(hero.locator('h1')).toHaveAttribute('aria-label', t.h1);
      await expect(hero.locator('h1 .accent')).toHaveCount(1);
      await expect(hero.locator('.hero__sub')).toHaveText(t.sub);
      // No intro plate and no scroll cue on a banner.
      await expect(page.locator('.intro')).toHaveCount(0);
      await expect(hero.locator('.hero__scroll')).toHaveCount(0);
      // The loop plays the design's later window, so it does not replay the home opening.
      await expect(hero.locator('.hero__media')).toHaveAttribute('data-clip-start', '6.2');
      await expect(hero.locator('.hero__media')).toHaveAttribute('data-clip-end', '7.9');
    });

    test('the hero CTA is the icon-first badge to the inquiry form', async ({ page }) => {
      await page.goto(route);
      const cta = page.locator('.hero__cta');
      await expect(cta).toHaveText(t.cta);
      await expect(cta).toHaveAttribute('href', '#inquiry');
      await expect(cta).toHaveClass(/cta--badge/);
      const iconFirst = await cta.evaluate(
        (el) => el.firstElementChild?.classList.contains('cta__ico') ?? false,
      );
      expect(iconFirst, 'the icon comes first, as the design draws it').toBe(true);
      await expect(page.locator('#inquiry')).toHaveCount(1);
    });

    test('the section heads carry the design’s copy and accents', async ({ page }) => {
      await page.goto(route);
      await expect(page.locator('#inquiry h2')).toHaveText(t.inquiry);
      await expect(page.locator('.contact-touch .sec-head h2')).toHaveText(t.touch);
      await expect(page.locator('#faq h2')).toHaveText(t.faq);
      for (const sel of ['#inquiry h2 em', '.contact-touch .sec-head h2 em', '#faq h2 em']) {
        await expect(page.locator(sel), sel).toHaveCount(1);
      }
      await expect(page.locator('.faq-item__t').first()).toHaveText(t.firstQ);
    });

    test('every kicker and heading accent meets AA against its own band', async ({ page }) => {
      await page.goto(route);
      const results = await page.evaluate(accentContrasts);
      expect(results.length).toBeGreaterThanOrEqual(6);
      for (const r of results) expect(r.ratio, `"${r.text}"`).toBeGreaterThanOrEqual(4.5);
    });

    test('the FAQ is the design’s dark band', async ({ page }) => {
      await page.goto(route);
      const bg = await page.locator('#faq').evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(bg).toBe('rgb(0, 0, 0)');
    });

    test('the full form: the design’s fields, consent and honeypot', async ({ page }) => {
      await page.goto(route);
      const names = await page
        .locator('#contact-form')
        .locator('input, select, textarea')
        .evaluateAll((els) => els.map((e) => e.getAttribute('name')));
      expect(names).toEqual([
        'name',
        'email',
        'company',
        'service',
        'budget',
        'deadline',
        'message',
        'consent',
        'hp',
      ]);
      await expect(page.locator('#cf-phone')).toHaveCount(0);
      const deadline = page.locator('#cf-deadline');
      await expect(deadline).toHaveAttribute('type', 'text');
      await expect(deadline).toHaveAttribute('maxlength', '120'); // mirrors timelineText
      const labels = await page.$$eval('#cf-budget option', (os) =>
        os.slice(1).map((o) => (o.textContent ?? '').trim()),
      );
      expect(labels).toEqual([...t.budgets]);
      await expect(page.locator('#contact-form button[type="submit"]')).toHaveText(t.submit);
    });

    test('a sent inquiry posts kind=project_inquiry with only schema keys', async ({ page }) => {
      let body: Record<string, unknown> = {};
      await page.route('**/api/contact', async (r) => {
        body = r.request().postDataJSON() as Record<string, unknown>;
        await r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      });
      await page.goto(route);
      await page.locator('#cf-name').fill('Kareem');
      await page.locator('#cf-email').fill('k@example.com');
      await page.locator('#cf-budget').selectOption('25k_75k');
      await page.locator('#cf-deadline').fill('Before Ramadan');
      await page.locator('#cf-message').fill('A launch film.');
      await page.locator('#cf-consent').check();
      await page.locator('#contact-form button[type="submit"]').click();

      const status = page.locator('#contact-status');
      await expect(status).toHaveText(t.ok);
      await expect(status).toBeFocused();
      await expect(page.locator('#cf-name')).toBeHidden();
      expect(body).toMatchObject({
        kind: 'project_inquiry',
        locale: t.locale,
        budgetBand: '25k_75k',
        timelineText: 'Before Ramadan',
        consentMarketing: true,
      });
      for (const key of Object.keys(body)) expect(SCHEMA_KEYS, key).toContain(key);
    });

    test('a bad submission names each field in words; focus goes to the first', async ({
      page,
    }) => {
      await page.goto(route);
      await page.locator('#contact-form button[type="submit"]').click();
      const name = page.locator('#cf-name');
      await expect(name).toHaveAttribute('aria-invalid', 'true');
      await expect(name).toBeFocused();
      const describedBy = await name.getAttribute('aria-describedby');
      await expect(page.locator(`#${describedBy}`)).not.toBeEmpty();
      await expect(page.locator('#cf-deadline')).not.toHaveAttribute('aria-invalid', 'true');
    });

    test('channels come from the identity; no WhatsApp card without a real number', async ({
      page,
    }) => {
      await page.goto(route);
      const mail = page.locator('.touch-card[href^="mailto:"]');
      await expect(mail).toHaveCount(1);
      await expect(mail.locator('.touch-card__ico')).toHaveCount(1);
      // The seed sets no WhatsApp number: the design's wa.me/9665XXXXXXXX placeholder must
      // never ship as a dead link.
      await expect(page.locator('a[href*="wa.me"]')).toHaveCount(0);
      await expect(page.locator('main')).not.toContainText('5X XXX');
    });
  });
}
