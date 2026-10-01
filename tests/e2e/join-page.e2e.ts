import { expect, test, type Page, type Route } from '@playwright/test';

/*
 * /join and /ar/join — the Join page and its application form, the second public write
 * path (and the first with a file).
 *
 * The endpoint (/api/apply, /api/apply/status) is built separately; every answer here is
 * mocked with page.route, so these tests prove the PAGE's half on its own: the bands
 * server-rendered in the design's order, real labels, keys (never labels) on the wire,
 * the craft chips as real checkboxes, the closed notice shown with no layout shift, the
 * client checks, the one status region for each answer, and the no-JS answer page
 * (`?status=`) — rendered server-side and never edge-cached. The real upload round trip
 * is the endpoint's suite.
 */

const ROUTES = ['/join', '/ar/join'] as const;

const PAGE = {
  '/join': {
    locale: 'en',
    h1: 'Join the station',
    cta: 'Apply now',
    why: 'Work that leaves the building',
    steps: 'From application to first brief',
    apply: 'Show us what you make',
    groups: ['About you', 'The role', 'Your work'],
    labels: {
      'af-name': 'Full name',
      'af-email': 'Email',
      'af-phone': 'Phone',
      'af-city': 'City',
      'af-role': "Role you're interested in",
      'af-experience': 'Experience',
      'af-work-type': "How you'd like to work",
      'af-availability': 'When could you start?',
      'af-portfolio': 'Portfolio link',
      'af-linkedin': 'LinkedInoptional',
      'af-message': "The piece you're proudest of, and why",
    },
    levels: ['Student or graduate', '1 to 3 years', '3 to 6 years', '6+ years'],
    firstCraft: 'Branding',
    cvHint: 'PDF or Word (.docx), up to 10 MB',
    send: 'Send application',
    ok: "Application received. We'll review your work and reply within two weeks.",
    invalid: 'Some answers are missing or need another look. Please check the form and try again.',
    badType: "That file won't work. Use a PDF or Word (.docx) file under 10 MB.",
    closed: "We're not taking applications right now. Check back soon.",
    errEmail: 'Enter a valid email address, like you@email.com.',
    consent: 'I agree that Braiin Statiion can store and review this application',
    privacy: '/privacy#recruitment',
    brandTag: 'Why Braiin Statiion',
  },
  '/ar/join': {
    locale: 'ar',
    h1: 'انضم إلى المحطة',
    cta: 'قدّم الآن',
    why: 'شغل يطلع للعالم',
    steps: 'من التقديم إلى أول بريف',
    apply: 'ورّنا وش تصنع',
    groups: ['عنك', 'الوظيفة', 'أعمالك'],
    labels: {
      'af-name': 'الاسم الكامل',
      'af-email': 'البريد الإلكتروني',
      'af-phone': 'الجوال',
      'af-city': 'المدينة',
      'af-role': 'الوظيفة اللي تهمّك',
      'af-experience': 'الخبرة',
      'af-work-type': 'كيف تحب تشتغل',
      'af-availability': 'متى تقدر تبدأ؟',
      'af-portfolio': 'رابط أعمالك',
      'af-linkedin': 'لينكدإناختياري',
      'af-message': 'العمل اللي تفتخر فيه أكثر، وليش',
    },
    levels: ['طالب أو خريج', 'من سنة إلى ٣ سنوات', 'من ٣ إلى ٦ سنوات', 'أكثر من ٦ سنوات'],
    firstCraft: 'الهوية البصرية',
    cvHint: 'PDF أو Word ‏(.docx)، حتى ١٠ ميجابايت',
    send: 'أرسل الطلب',
    ok: 'وصلنا طلبك. بنراجع أعمالك ونرد عليك خلال أسبوعين.',
    invalid: 'بعض الإجابات ناقصة أو تحتاج إلى مراجعة. يرجى مراجعة النموذج والمحاولة مرة أخرى.',
    badType: 'لا يمكن قبول هذا الملف. استخدم ملف PDF أو Word ‏(.docx) أقل من ١٠ ميجابايت.',
    closed: 'لا نستقبل طلبات التوظيف حاليًا. عُد إلينا قريبًا.',
    errEmail: 'أدخل بريدًا إلكترونيًا صحيحًا، مثل you@email.com.',
    consent: 'أوافق على أن تحفظ بريّن ستيشن هذا الطلب وتراجعه',
    privacy: '/ar/privacy#recruitment',
    brandTag: 'ليش بريّن ستيشن',
  },
} as const;

const LEVEL_KEYS = ['', 'student', '1-3', '3-6', '6-plus'];
const WORK_KEYS = ['', 'full-time', 'freelance', 'internship', 'any'];
const START_KEYS = ['', 'immediately', 'two-weeks', 'month', 'later'];
const CRAFT_KEYS = [
  'branding',
  'animation',
  'motion-graphics',
  'videography',
  'photography',
  'montage',
  'event-planning',
  'advertising',
  'social-media',
  'web-development',
  'seo-geo-aeo',
  'music',
  'merchandise',
  'gaming',
  'copywriting',
  'strategy',
];

/** Applications are open (the endpoint is mocked: these tests never depend on its config). */
async function openApplications(page: Page): Promise<void> {
  await page.route('**/api/apply/status', (r) => r.fulfill({ json: { open: true } }));
}

/** Fills every field the schema requires, validly. */
async function fillValid(page: Page): Promise<void> {
  await page.locator('#af-name').fill('Noura Al-Harbi');
  await page.locator('#af-email').fill('noura@example.com');
  await page.locator('#af-phone').fill('+966501234567');
  await page.locator('#af-city').fill('Jeddah');
  await page.locator('#af-role').fill('Motion designer');
  await page.locator('#af-experience').selectOption('3-6');
  await page.locator('#af-work-type').selectOption('full-time');
  await page.locator('#af-availability').selectOption('month');
  await page.locator('label.af-chip:has(input[value="animation"])').click();
  await page.locator('#af-portfolio').fill('https://behance.net/noura');
  await page.locator('#af-message').fill('The launch film for a coffee brand.');
  await page.locator('#af-consent-application').check();
}

const PDF = { name: 'noura-cv.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7') };

interface Shift {
  value: number;
  recent: boolean;
}
async function watchShifts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __shifts: Shift[] };
    w.__shifts = [];
    const since = performance.now();
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as (PerformanceEntry & {
        value: number;
        hadRecentInput: boolean;
      })[]) {
        if (e.startTime >= since) w.__shifts.push({ value: e.value, recent: e.hadRecentInput });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
}
const counted = async (page: Page) =>
  (await page.evaluate(() => (window as unknown as { __shifts: Shift[] }).__shifts))
    .filter((s) => !s.recent)
    .reduce((sum, s) => sum + s.value, 0);

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

for (const route of ROUTES) {
  const t = PAGE[route];

  test.describe(`join — ${route}`, () => {
    test('the bands are server-rendered, in the design’s order', async ({ browser, request }) => {
      // No script at all: what a crawler and a no-JS visitor get.
      const ctx = await browser.newContext({ javaScriptEnabled: false });
      const page = await ctx.newPage();
      await page.goto(route);
      const bands = await page.$$eval('main > section', (els) => els.map((e) => e.className));
      expect(bands.map((c) => c.split(' ')[0])).toEqual([
        'hero',
        'join-why',
        'join-steps',
        'join-apply',
      ]);
      await expect(page.locator('.join-why h2')).toHaveText(t.why);
      await expect(page.locator('.join-steps h2')).toHaveText(t.steps);
      await expect(page.locator('.join-apply h2')).toHaveText(t.apply);
      await expect(page.locator('.join-why .tag')).toHaveText(t.brandTag);
      await expect(page.locator('.join-why__item')).toHaveCount(4);
      await expect(page.locator('.join-steps__list > li')).toHaveCount(4);
      await expect(page.locator('.af-group__t')).toHaveText([...t.groups]);
      await ctx.close();

      // The served markup itself (no hydration, no script-built content).
      const html = await (await request.get(route)).text();
      expect(html.match(/name="skills"/g) ?? []).toHaveLength(16);
      expect(html).toContain('id="apply-form"');
    });

    test('one <main>, opening with the join banner — its CTA to the form', async ({ page }) => {
      await page.goto(route);
      await expect(page.locator('main')).toHaveCount(1);
      const hero = page.locator('main > .hero');
      await expect(hero).toHaveClass(/hero--banner/);
      await expect(hero.locator('h1')).toHaveAttribute('aria-label', t.h1);
      expect(await hero.locator('h1').evaluate((el) => el.textContent)).toBe(t.h1);
      await expect(hero.locator('h1 .accent')).toHaveCount(1);
      await expect(page.locator('.intro')).toHaveCount(0);
      await expect(hero.locator('.hero__media')).toHaveAttribute('data-clip-start', '17.4');
      await expect(hero.locator('.hero__media')).toHaveAttribute('data-clip-end', '18.3');
      const cta = page.locator('.hero__cta');
      await expect(cta).toHaveText(t.cta);
      await expect(cta).toHaveAttribute('href', '#apply');
      await expect(page.locator('#apply')).toHaveCount(1);
      await expect(page.locator('.site-header')).toHaveClass(/site-header--overlay/);
      // Join is current in the header, and the last item.
      const current = page.locator('.site-nav__list a[aria-current="page"]');
      await expect(current).toHaveCount(1);
      await expect(current).toHaveAttribute('href', route);
      await expect(page.locator('.site-nav__list > li').last().locator('a')).toHaveAttribute(
        'href',
        route,
      );
    });

    test('the form: multipart to /api/apply, the honeypot, the hidden fields', async ({ page }) => {
      await page.goto(route);
      const form = page.locator('#apply-form');
      await expect(form).toHaveAttribute('method', 'post');
      await expect(form).toHaveAttribute('action', '/api/apply');
      await expect(form).toHaveAttribute('enctype', 'multipart/form-data');
      await expect(form).toHaveAttribute('novalidate', '');
      const hp = page.locator('#af-hp');
      await expect(hp).toHaveAttribute('name', 'hp');
      await expect(hp).toHaveAttribute('tabindex', '-1');
      await expect(hp).toHaveAttribute('autocomplete', 'off');
      await expect(page.locator('input[type="hidden"][name="locale"]')).toHaveValue(t.locale);
      await expect(page.locator('input[type="hidden"][name="policy_version"]')).toHaveValue(
        /^\d{4}-\d{2}-\d{2}$/,
      );
      // The status region and a message for every answer the endpoint can give.
      const status = page.locator('#apply-status');
      await expect(status).toHaveAttribute('role', 'status');
      await expect(status).toHaveAttribute('aria-live', 'polite');
      await expect(status).toHaveAttribute('tabindex', '-1');
      for (const attr of [
        'data-sending',
        'data-ok',
        'data-invalid',
        'data-too-large',
        'data-bad-type',
        'data-rate-limited',
        'data-unavailable',
        'data-closed',
        'data-error',
      ]) {
        expect(await status.getAttribute(attr), attr).toBeTruthy();
      }
    });

    test('every control has its real label', async ({ page }) => {
      await page.goto(route);
      for (const [id, label] of Object.entries(t.labels)) {
        await expect(page.locator(`label[for="${id}"]`), id).toHaveText(label);
      }
      const unlabelled = await page.$$eval(
        '#apply-form input:not([type="hidden"]):not(#af-hp), #apply-form select, #apply-form textarea',
        (els) =>
          els.filter((e) => ((e as HTMLInputElement).labels?.length ?? 0) === 0).map((e) => e.id),
      );
      expect(unlabelled).toEqual([]);
      // Links and contact details are LTR in both languages.
      for (const id of ['af-email', 'af-phone', 'af-portfolio', 'af-linkedin']) {
        await expect(page.locator(`#${id}`)).toHaveAttribute('dir', 'ltr');
      }
      await expect(page.locator('#af-portfolio')).toHaveAttribute('type', 'url');
      await expect(page.locator('#af-linkedin')).toHaveAttribute('type', 'url');
      await expect(page.locator('#af-name')).toHaveAttribute('autocomplete', 'name');
      await expect(page.locator('#af-email')).toHaveAttribute('autocomplete', 'email');
      await expect(page.locator('#af-phone')).toHaveAttribute('autocomplete', 'tel');
    });

    test('the selects post keys, never their visible labels', async ({ page }) => {
      await page.goto(route);
      const values = (sel: string) =>
        page.$$eval(`${sel} option`, (os) => os.map((o) => o.getAttribute('value')));
      expect(await values('#af-experience')).toEqual(LEVEL_KEYS);
      expect(await values('#af-work-type')).toEqual(WORK_KEYS);
      expect(await values('#af-availability')).toEqual(START_KEYS);
      const labels = await page.$$eval('#af-experience option', (os) =>
        os.slice(1).map((o) => (o.textContent ?? '').trim()),
      );
      expect(labels).toEqual([...t.levels]);
    });

    test('the sixteen crafts are real, keyboard-operable checkboxes', async ({ page }) => {
      await page.goto(route);
      const chips = page.locator('input[type="checkbox"][name="skills"]');
      await expect(chips).toHaveCount(16);
      expect(
        await chips.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value)),
      ).toEqual(CRAFT_KEYS);
      await expect(page.locator('label.af-chip').first()).toHaveText(t.firstCraft);
      // The group is named by its visible label.
      const group = page.locator('[role="group"].af-chips');
      const labelledBy = await group.getAttribute('aria-labelledby');
      await expect(page.locator(`#${labelledBy}`)).not.toBeEmpty();
      // Space toggles a focused chip, and its pill shows the state.
      const first = chips.first();
      await first.focus();
      await page.keyboard.press('Space');
      await expect(first).toBeChecked();
      const pill = page.locator('label.af-chip').first().locator('span');
      await expect
        .poll(() => pill.evaluate((el) => getComputedStyle(el).backgroundColor))
        .toBe('rgb(0, 36, 188)');
      expect(await pill.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
    });

    test('consent: two boxes, the first required, and the privacy section in a new tab', async ({
      page,
    }) => {
      await page.goto(route);
      const application = page.locator('#af-consent-application');
      await expect(application).toHaveAttribute('type', 'checkbox');
      await expect(application).toHaveAttribute('name', 'consent_application');
      await expect(application).toHaveAttribute('required', '');
      await expect(page.locator('label[for="af-consent-application"]')).toContainText(t.consent);
      const future = page.locator('#af-consent-future');
      await expect(future).toHaveAttribute('name', 'consent_future');
      await expect(future).not.toHaveAttribute('required', '');
      const link = page.locator('.af-privacy a');
      await expect(link).toHaveAttribute('href', t.privacy);
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', /noopener/);
    });

    test('closed: the notice takes the lead line’s place — nothing moves — and send is off', async ({
      page,
    }) => {
      let release!: () => void;
      const answered = new Promise<void>((r) => (release = r));
      await page.route('**/api/apply/status', async (r: Route) => {
        await answered;
        await r.fulfill({ json: { open: false } });
      });
      // Reduced motion: no reveal transform is mid-flight while the boxes are measured.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setViewportSize({ width: 1366, height: 900 });
      await page.goto(route, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      await page.locator('#apply').scrollIntoViewIfNeeded();
      const lead = page.locator('#apply-lead');
      const before = (await lead.boundingBox())!;
      const formTop = (await page.locator('#apply-form').boundingBox())!.y;
      await expect(page.locator('.join-apply__closed')).toHaveCSS('visibility', 'hidden');

      await watchShifts(page);
      release();
      await expect(lead).toHaveAttribute('data-closed', 'true');
      await expect(page.locator('.join-apply__closed')).toHaveText(t.closed);
      await expect(page.locator('.join-apply__closed')).toHaveCSS('visibility', 'visible');
      await expect(page.locator('.join-apply__p')).toHaveCSS('visibility', 'hidden');
      await expect(page.locator('#apply-form button[type="submit"]')).toBeDisabled();
      await page.waitForTimeout(500);
      expect(await counted(page), 'layout shift from the closed notice').toBe(0);
      expect((await lead.boundingBox())!.height).toBe(before.height);
      expect((await page.locator('#apply-form').boundingBox())!.y).toBe(formTop);
    });

    test('open: the form stays as served', async ({ page }) => {
      await openApplications(page);
      await page.goto(route, { waitUntil: 'load' });
      await expect(page.locator('#apply-lead')).toHaveAttribute('data-closed', 'false');
      await expect(page.locator('.join-apply__closed')).toHaveCSS('visibility', 'hidden');
      await expect(page.locator('#apply-form button[type="submit"]')).toBeEnabled();
    });

    test('a status answer that is not one leaves the form open — and the page idle', async ({
      page,
    }) => {
      // A 404 page (no endpoint yet, a proxy's error): the form stays as served, and its body
      // is read — an unread one is a request Chromium never finishes, so the page never went
      // network-idle (the axe pass waits for exactly that). The site's own 404, streamed from
      // the server: a fulfilled mock arrives whole and would not show it.
      await page.route('**/api/apply/status', (r) =>
        r.continue({ url: r.request().url().replace('/api/apply/status', '/api/apply/__none__') }),
      );
      await page.goto(route, { waitUntil: 'networkidle', timeout: 15_000 });
      await expect(page.locator('#apply-lead')).toHaveAttribute('data-closed', 'false');
      await expect(page.locator('#apply-form button[type="submit"]')).toBeEnabled();
    });

    test('an invalid email is named in words, before any upload', async ({ page }) => {
      await openApplications(page);
      let posted = 0;
      await page.route('**/api/apply', async (r) => {
        posted += 1;
        await r.fulfill({ status: 200, json: { status: 'ok' } });
      });
      await page.goto(route);
      await fillValid(page);
      await page.locator('#af-email').fill('noura@');
      await page.locator('#apply-form button[type="submit"]').click();
      const email = page.locator('#af-email');
      await expect(email).toHaveAttribute('aria-invalid', 'true');
      await expect(email).toBeFocused();
      const describedBy = (await email.getAttribute('aria-describedby'))!;
      await expect(page.locator(`#${describedBy.split(' ').at(-1)}`)).toHaveText(t.errEmail);
      await expect(page.locator('#apply-status')).toHaveText(t.invalid);
      await expect(page.locator('#af-name')).not.toHaveAttribute('aria-invalid', 'true');
      expect(posted).toBe(0);
      // Fixing it clears the mark.
      await email.fill('noura@example.com');
      await expect(email).not.toHaveAttribute('aria-invalid', 'true');
    });

    test('an unticked consent and a non-https link are refused in words', async ({ page }) => {
      await openApplications(page);
      await page.goto(route);
      await fillValid(page);
      await page.locator('#af-consent-application').uncheck();
      await page.locator('#af-portfolio').fill('http://behance.net/noura');
      await page.locator('#apply-form button[type="submit"]').click();
      await expect(page.locator('#af-portfolio')).toHaveAttribute('aria-invalid', 'true');
      await expect(page.locator('#af-portfolio')).toBeFocused();
      const consent = page.locator('#af-consent-application');
      await expect(consent).toHaveAttribute('aria-invalid', 'true');
      await expect(page.locator('#af-consent-application-error')).not.toBeEmpty();
      await consent.check();
      await expect(consent).not.toHaveAttribute('aria-invalid', 'true');
    });

    test('a received application shows the confirmation; the post is the contract', async ({
      page,
    }) => {
      await openApplications(page);
      let body = '';
      let accept = '';
      let contentType = '';
      await page.route('**/api/apply', async (r) => {
        body = r.request().postDataBuffer()?.toString('utf8') ?? '';
        accept = (await r.request().allHeaders())['accept'] ?? '';
        contentType = (await r.request().allHeaders())['content-type'] ?? '';
        await r.fulfill({ status: 200, json: { status: 'ok' } });
      });
      await page.goto(route);
      await fillValid(page);
      await page.setInputFiles('#af-cv', PDF);
      await page.locator('#apply-form button[type="submit"]').click();

      const status = page.locator('#apply-status');
      await expect(status).toHaveText(t.ok);
      await expect(status).toBeFocused();
      await expect(page.locator('#apply-form')).toHaveClass(/is-sent/);
      await expect(page.locator('#af-name')).toBeHidden();

      expect(accept).toContain('application/json');
      expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
      const part = (name: string) =>
        new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`).exec(body)?.[1];
      expect(part('work_type')).toBe('full-time');
      expect(part('experience')).toBe('3-6');
      expect(part('skills')).toBe('animation');
      expect(part('consent_application')).toBe('yes');
      expect(part('consent_future')).toBeUndefined();
      expect(part('locale')).toBe(t.locale);
      expect(part('hp')).toBe('');
      expect(body).toContain('name="cv"; filename="noura-cv.pdf"');
    });

    test('a refused file shows its message and marks the CV', async ({ page }) => {
      await openApplications(page);
      await page.route('**/api/apply', (r) =>
        r.fulfill({ status: 415, json: { status: 'bad_type' } }),
      );
      await page.goto(route);
      await fillValid(page);
      await page.setInputFiles('#af-cv', PDF);
      await page.locator('#apply-form button[type="submit"]').click();
      await expect(page.locator('#apply-status')).toHaveText(t.badType);
      await expect(page.locator('[data-cv-drop]')).toHaveAttribute('data-state', 'bad');
      await expect(page.locator('#af-cv')).toHaveAttribute('aria-invalid', 'true');
      await expect(page.locator('#af-cv')).toBeFocused();
    });

    test('a 422 marks the fields the server named', async ({ page }) => {
      await openApplications(page);
      await page.route('**/api/apply', (r) =>
        r.fulfill({ status: 422, json: { status: 'invalid', fields: ['workType', 'portfolio'] } }),
      );
      await page.goto(route);
      await fillValid(page);
      await page.locator('#apply-form button[type="submit"]').click();
      await expect(page.locator('#apply-status')).toHaveText(t.invalid);
      await expect(page.locator('#af-work-type')).toHaveAttribute('aria-invalid', 'true');
      await expect(page.locator('#af-portfolio')).toHaveAttribute('aria-invalid', 'true');
      await expect(page.locator('#af-work-type')).toBeFocused();
      await expect(page.locator('#af-name')).not.toHaveAttribute('aria-invalid', 'true');
    });

    test('the CV: a .doc is refused before upload, a PDF is named, Remove clears it', async ({
      page,
    }) => {
      await page.goto(route);
      const drop = page.locator('[data-cv-drop]');
      const cv = page.locator('#af-cv');
      await expect(drop).toHaveAttribute('data-state', 'empty');
      await expect(page.locator('#af-cv-hint')).toHaveText(t.cvHint);
      await expect(page.locator('.af-drop__x')).toHaveCSS('visibility', 'hidden');
      const height = (await drop.boundingBox())!.height;

      await page.setInputFiles('#af-cv', {
        name: 'old-cv.doc',
        mimeType: 'application/msword',
        buffer: Buffer.from('doc'),
      });
      await expect(drop).toHaveAttribute('data-state', 'bad');
      await expect(cv).toHaveAttribute('aria-invalid', 'true');
      await expect(cv).toHaveAttribute('aria-describedby', 'af-cv-bad');
      expect((await drop.boundingBox())!.height).toBe(height);

      await page.setInputFiles('#af-cv', PDF);
      await expect(drop).toHaveAttribute('data-state', 'ok');
      await expect(cv).not.toHaveAttribute('aria-invalid', 'true');
      await expect(page.locator('[data-cv-name]')).toHaveText('noura-cv.pdf');
      await expect(page.locator('.af-drop__x')).toHaveCSS('visibility', 'visible');
      expect((await drop.boundingBox())!.height).toBe(height);

      // Remove is outside the label: pressing it clears the file, opening no picker.
      let chooser = false;
      page.on('filechooser', () => (chooser = true));
      await page.locator('.af-drop__x').click();
      await expect(drop).toHaveAttribute('data-state', 'empty');
      expect(await cv.evaluate((el) => (el as HTMLInputElement).files?.length ?? 0)).toBe(0);
      await expect(cv).toBeFocused();
      expect(chooser).toBe(false);
    });

    test('no-JS answer: ?status=ok renders the confirmation server-side, never cached', async ({
      request,
      browser,
    }) => {
      const res = await request.get(`${route}?status=ok`);
      expect(res.status()).toBe(200);
      expect(res.headers()['cache-control']).toBe('private, no-store');
      expect(res.headers()['cache-tag']).toBeUndefined();
      const html = await res.text();
      expect(html).toMatch(/<form[^>]*class="apply-form is-sent"/);
      expect(html).toMatch(/<p[^>]*id="apply-status"[^>]*>/);
      expect(html.match(/<p[^>]*id="apply-status"[^>]*>/)![0]).not.toMatch(/\shidden/);
      expect(html).toContain(t.ok.replace(/'/g, '&#39;'));
      // Its canonical is the bare page.
      expect(html).toContain(`rel="canonical" href="https://www.braiinstation.com${route}"`);

      // ...and a browser with no script shows it at the top of the form, where #apply lands.
      const ctx = await browser.newContext({ javaScriptEnabled: false });
      const page = await ctx.newPage();
      await page.goto(`${route}?status=bad_type#apply`);
      const status = page.locator('#apply-status');
      await expect(status).toBeVisible();
      await expect(status).toHaveText(t.badType);
      await expect(page.locator('#apply-form > *').first()).toHaveAttribute('id', 'apply-status');
      await expect(page.locator('#af-name')).toBeVisible();
      await ctx.close();
    });

    test('no-JS answer: closed shows the notice; a crafted status renders nothing', async ({
      request,
    }) => {
      const closed = await (await request.get(`${route}?status=closed`)).text();
      expect(closed).toContain('data-closed="true"');
      const crafted = await request.get(`${route}?status=%3Cscript%3Ealert(1)%3C/script%3E`);
      expect(crafted.headers()['cache-control']).toBe('private, no-store');
      const html = await crafted.text();
      expect(html).not.toContain('<script>alert(1)');
      expect(html.match(/<p[^>]*id="apply-status"[^>]*>/)![0]).toMatch(/\shidden/);
      // The bare page is Tier A.
      const bare = await request.get(route);
      expect(bare.headers()['cache-control']).toContain('s-maxage=');
      expect(bare.headers()['cache-tag']).toContain('route:join');
    });

    test('every kicker and heading accent meets AA against its own band', async ({ page }) => {
      await page.goto(route);
      const results = await page.evaluate(accentContrasts);
      expect(results.length).toBeGreaterThanOrEqual(6);
      for (const r of results) expect(r.ratio, `"${r.text}"`).toBeGreaterThanOrEqual(4.5);
    });

    test('no horizontal scroll (the honeypot is offset logically)', async ({ page }) => {
      for (const width of [1366, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(route, { waitUntil: 'load' });
        const overflow = await page.evaluate(() => {
          const el = document.scrollingElement!;
          return el.scrollWidth - el.clientWidth;
        });
        expect(overflow, `page scrolls horizontally at ${width}px`).toBeLessThanOrEqual(1);
      }
    });
  });
}

test('/ar/join is RTL Arabic throughout', async ({ page }) => {
  await page.goto('/ar/join');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('.join-why__item h3').first()).toHaveText('خمسة تخصصات، غرفة واحدة');
  await expect(page.locator('.join-step__time').nth(2)).toHaveText('حوالي ٤٥ دقيقة');
  await expect(page.locator('#apply-form button[type="submit"]')).toHaveText('أرسل الطلب');
  expect(await page.locator('.join-why').evaluate((el) => getComputedStyle(el).direction)).toBe(
    'rtl',
  );
});

test('the privacy notice carries the recruitment section the consent links to', async ({
  request,
}) => {
  for (const path of ['/privacy', '/ar/privacy']) {
    const html = await (await request.get(path)).text();
    expect(html, path).toContain('<section id="recruitment">');
  }
});
