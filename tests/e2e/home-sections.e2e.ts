import { expect, test, type Page } from '@playwright/test';

/*
 * Home (UI v2 PR7), EN + AR, against the seeded local database (supabase/seed.sql — the
 * design's sample projects, numbers and quotes are PUBLISHED there, drafts in production).
 *
 * The mockup built most of this page with script (the featured blurb, the statement, the
 * numbers' "0", the quotes, the client names, the service options). Every assertion below
 * reads the SERVED markup or the live DOM of a server-rendered page — the port's contract
 * is that all of it is in the HTML (Tier A).
 */

// The intro is a timed plate over everything; these tests are about the sections, so they
// start as a returning visitor in this tab (the intro cuts on the session flag).
async function skipIntro(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      sessionStorage.setItem('bs_intro', '1');
    } catch {
      /* storage blocked: the intro still ends on its own */
    }
  });
}

const HOME = {
  en: {
    root: '/',
    prefix: '',
    cta: 'See our work',
    clients: ['Riyadh Season', 'NEOM', 'stc', 'Saudia'],
    since: 'Since 2019',
    featured: 'The Rider',
    link: 'See the project',
    cards: ['Kitchen Hours | Product campaign', 'Notebook | Rebrand'],
    heading: 'Ideas that leave the brain and land in the world.',
    accent: 'leave the brain',
    button: 'See all our work',
    numbers: 'The work, counted',
    quotes: 'In their words',
    why: 'Why Braiin Statiion',
    submit: 'Send message',
    ok: "Got it. We'll be in touch within one business day.",
  },
  ar: {
    root: '/ar',
    prefix: '/ar',
    cta: 'شوف أعمالنا',
    clients: ['موسم الرياض', 'نيوم', 'stc', 'السعودية'],
    since: 'منذ ٢٠١٩',
    featured: 'الراكب',
    link: 'شوف المشروع',
    cards: ['ساعات المطبخ | حملة منتج', 'الدفتر | إعادة بناء هوية'],
    heading: 'أفكار تطلع من الدماغ وتوصل للعالم.',
    accent: 'تطلع من الدماغ',
    button: 'شوف كل أعمالنا',
    numbers: 'الشغل بالأرقام',
    quotes: 'بكلماتهم هم',
    why: 'ليش بريّن ستيشن',
    submit: 'أرسل الرسالة',
    ok: 'وصلتنا. بنتواصل معك خلال يوم عمل واحد.',
  },
} as const;

test.beforeEach(async ({ page }) => {
  await skipIntro(page);
});

for (const locale of ['en', 'ar'] as const) {
  const t = HOME[locale];

  test.describe(`home — ${t.root}`, () => {
    test("the bands are the design's, in its order", async ({ page }) => {
      await page.goto(t.root);
      const order = await page.$$eval('main > section, main > .hero', (els) =>
        els.map((el) => el.id || el.className.split(' ')[0]),
      );
      expect(order).toEqual([
        'hero',
        'clients',
        'selected-work',
        'numbers',
        'testimonials',
        'services',
        'about',
        'slogan',
        'contact',
        'social-strip',
      ]);
    });

    test('the hero sends "See our work" to the Selected work band', async ({ page }) => {
      await page.goto(t.root);
      const cta = page.locator('.hero__cta');
      await expect(cta).toHaveText(t.cta);
      await expect(cta).toHaveAttribute('href', '#selected-work');
      // The accent stops before the footnote mark: <em>performs</em>*.
      await expect(page.locator('.hero h1 .accent .letter--plain')).toHaveText('*');
    });

    test('clients come from the table, in this language, with the founding year', async ({
      page,
    }) => {
      await page.goto(t.root);
      const names = await page.$$eval('#clients .marquee:not(.marquee--rev) .marquee-item', (els) =>
        els.filter((e) => !e.hasAttribute('aria-hidden')).map((e) => e.textContent?.trim()),
      );
      expect(names).toHaveLength(8);
      expect(names.slice(0, 4)).toEqual(t.clients);
      await expect(page.locator('#clients .clients__head span')).toHaveText(t.since);
    });

    test('Selected work is server-rendered: the featured project, its facets, two cards', async ({
      request,
      page,
    }) => {
      const html = await (await request.get(t.root)).text();
      // Tier A: the words are in the response, not filled in by script.
      for (const s of [t.featured, t.heading.split(' ')[0]!, t.cards[0], t.button]) {
        expect(html, s).toContain(s);
      }

      await page.goto(t.root);
      const band = page.locator('#selected-work');
      await expect(band.locator('.sel-work__blurb b')).toHaveText(t.featured);
      const link = band.locator('.sel-work__link');
      await expect(link).toHaveAttribute('href', `${t.prefix}/portfolio/the-rider`);
      await expect(link).toContainText(t.link);
      // Facet tags are real links into the filtered catalogue.
      await expect(band.locator('.sel-work__copy .ftag').first()).toHaveAttribute(
        'href',
        `${t.prefix}/portfolio/all?service=videography`,
      );
      await expect(band.locator('#sel-work-heading em')).toHaveText(t.accent);
      await expect(band.locator('.sel-work__lines li')).toHaveCount(3);
      await expect(band.locator('.pcard__t')).toHaveText([...t.cards]);
      const button = band.locator('.sel-work__foot a');
      await expect(button).toHaveText(t.button);
      await expect(button).toHaveAttribute('href', `${t.prefix}/portfolio`);
    });

    test('the numbers band renders its final values in the HTML (never "0")', async ({
      request,
    }) => {
      const html = await (await request.get(t.root)).text();
      const band = /<section[^>]*id="numbers"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
      expect(band).toContain(t.numbers.split(' ').pop()!);
      for (const v of ['14', '250+', '80+', '12']) expect(band).toContain(v);
    });

    test('the quotes are a carousel with a pause control, every quote in the HTML', async ({
      page,
    }) => {
      await page.goto(t.root);
      const band = page.locator('#testimonials');
      await expect(band).toHaveClass(/tm--klein/);
      await expect(band.locator('h2')).toHaveText(t.quotes);
      await expect(band.locator('[data-slide]')).toHaveCount(3);
      // WCAG 2.2.2: rotating content ships its own pause control (the mockup had none).
      await expect(band.locator('[data-toggle]')).toBeVisible();
    });

    test('"Why us" names the brand from the public identity', async ({ page }) => {
      await page.goto(t.root);
      await expect(page.locator('#about .tag')).toHaveText(t.why);
    });

    test('the compact lead form: the five design fields, consent and honeypot', async ({
      page,
    }) => {
      await page.goto(t.root);
      const form = page.locator('#contact form');
      const names = await form
        .locator('input, select, textarea')
        .evaluateAll((els) => els.map((e) => e.getAttribute('name')));
      expect(names).toEqual(['name', 'email', 'company', 'service', 'message', 'consent', 'hp']);
      await expect(form.locator('button[type="submit"]')).toHaveText(t.submit);
    });
  });
}

test.describe('the home lead form reports what really happened', () => {
  test('client-side: each bad field says what is wrong, and focus goes to the first', async ({
    page,
  }) => {
    await page.goto('/');
    await page.locator('#cf-email').fill('not-an-email');
    await page.locator('#contact-form button[type="submit"]').click();

    const name = page.locator('#cf-name');
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await expect(name).toBeFocused();
    const describedBy = await name.getAttribute('aria-describedby');
    await expect(page.locator(`#${describedBy}`)).toHaveText('This field is required.');
    await expect(page.locator('#cf-email')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#cf-message')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#cf-company')).not.toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#contact-status')).toBeVisible();

    // Typing clears that field's error.
    await name.fill('Kareem');
    await expect(name).not.toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator(`#${describedBy}`)).toHaveCount(0);
  });

  test('server 422: the fields it names are marked', async ({ page }) => {
    await page.route('**/api/contact', (route) =>
      route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'validation', fields: ['email'] }),
      }),
    );
    await page.goto('/');
    await page.locator('#cf-name').fill('Kareem');
    await page.locator('#cf-email').fill('k@example.com');
    await page.locator('#cf-message').fill('A brand for a launch.');
    await page.locator('#contact-form button[type="submit"]').click();
    await expect(page.locator('#cf-email')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#contact-status')).toHaveClass(/is-error/);
  });

  for (const locale of ['en', 'ar'] as const) {
    test(`success shows the design's confirmation and posts only schema keys — ${locale}`, async ({
      page,
    }) => {
      let body: Record<string, unknown> = {};
      await page.route('**/api/contact', async (route) => {
        body = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      });
      await page.goto(HOME[locale].root);
      await page.locator('#cf-name').fill('Kareem');
      await page.locator('#cf-email').fill('k@example.com');
      await page.locator('#cf-service').selectOption('branding');
      await page.locator('#cf-message').fill('A brand for a launch.');
      await page.locator('#cf-consent').check();
      await page.locator('#contact-form button[type="submit"]').click();

      const status = page.locator('#contact-status');
      await expect(status).toHaveText(HOME[locale].ok);
      await expect(status).toBeFocused();
      await expect(page.locator('#contact-form')).toHaveClass(/is-sent/);
      await expect(page.locator('#cf-name')).toBeHidden();

      expect(body).toMatchObject({
        kind: 'contact',
        locale,
        name: 'Kareem',
        email: 'k@example.com',
        serviceOfInterest: 'branding',
        consentMarketing: true,
        hp: '',
      });
      expect(Object.keys(body).sort()).toEqual(
        [
          'consentMarketing',
          'email',
          'hp',
          'kind',
          'locale',
          'message',
          'name',
          'serviceOfInterest',
        ].sort(),
      );
    });
  }

  test('a 429 and a 503 are told apart from a generic failure', async ({ page }) => {
    let answer = 429;
    await page.route('**/api/contact', (route) =>
      route.fulfill({ status: answer, contentType: 'application/json', body: '{}' }),
    );
    await page.goto('/');
    await page.locator('#cf-name').fill('Kareem');
    await page.locator('#cf-email').fill('k@example.com');
    await page.locator('#cf-message').fill('Hello.');
    const status = page.locator('#contact-status');
    await page.locator('#contact-form button[type="submit"]').click();
    await expect(status).toHaveText(/Too many attempts/);
    answer = 503;
    await page.locator('#contact-form button[type="submit"]').click();
    await expect(status).toHaveText(/isn’t live yet/);
  });
});

test('the featured clip mounts on intersection, not before (zero video bytes)', async ({
  page,
}) => {
  await page.goto('/', { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  const frame = page.locator('#selected-work .sel-work__media');
  await expect(frame).toHaveAttribute('data-clip-mode', 'inview');
  expect(await frame.locator('video').count(), 'mounted while off screen').toBe(0);
  await frame.scrollIntoViewIfNeeded();
  await expect(frame.locator('video')).toHaveCount(1, { timeout: 5000 });
});
