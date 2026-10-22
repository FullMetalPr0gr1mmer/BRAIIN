import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HelpArticleSeedSchema, type HelpArticleRow } from '@schemas/help';
import { CALENDLY_URL, GA4_ID, GSC_TOKEN } from '@schemas/integrations';
import { CV_MAX_BYTES } from '@schemas/application';
import { ROLES } from '@/lib/auth/types';
import { ROLE_CAPS } from '@/lib/authz/matrix';
import { mayRead, pageGuideFor } from '@/lib/admin/help';
import { visibleNav } from '@/lib/admin/nav';
import { settings } from '@/lib/admin/nav/settings';
import { INTEGRATION_TILES } from '@/lib/admin/integrations/tiles';
import { formFacts } from '@/lib/admin/forms/overview';
import { APPLY_LIMITS, CONTACT_LIMITS } from '@/lib/http/publicRateLimit';
import { helpSet, readMigrations } from '../fixtures/helpSet';

// The guides Admin v2 U11 puts through H11's catalog (one app.put_help_guide each, in the
// integrations migration, 0105): `integrations` and `forms-and-spam`, new,
// `your-account` again, for the bell's settings screen, and `the-sales-role` again, because
// that screen is the one setting a Sales account opens. Each is held to its file in
// docs/admin-v2/guides (byte for byte), to the revision the migrations before it leave, to
// its place and readers, and to the code behind what it says. tests/lib/helpCentre.spec.ts
// holds every guide to the rules all guides keep.

const FILES = readMigrations();
const HELP = helpSet(FILES);
const MIGRATION = FILES.find((f) => /^\d{4}_integrations\.sql$/.test(f.name));
const BEFORE = helpSet(FILES.filter((f) => f !== MIGRATION));

const guide = (slug: string): HelpArticleRow =>
  HelpArticleSeedSchema.parse(HELP.set.find((g) => g.slug === slug));
const text = (slug: string, lang: 'en' | 'ar') => {
  const g = guide(slug);
  return [
    lang === 'en' ? g.title : g.title_ar,
    ...g.body[lang].flatMap((b) => (Array.isArray(b.x) ? b.x : [b.x])),
  ].join('\n');
};
const readers = (slug: string) => ROLES.filter((role) => mayRead(role, guide(slug).caps));
const source = (path: string) => readFileSync(path, 'utf8');

describe('the guides the integrations migration puts (Admin v2 U11)', () => {
  it('puts exactly four, each at the revision the migrations before it leave', () => {
    expect(MIGRATION, 'the integrations migration').toBeDefined();
    expect(HELP.edits.filter((e) => e.file === MIGRATION!.name)).toEqual([
      { file: MIGRATION!.name, op: 'put', slug: 'integrations', revision: 0 },
      { file: MIGRATION!.name, op: 'put', slug: 'forms-and-spam', revision: 0 },
      {
        file: MIGRATION!.name,
        op: 'put',
        slug: 'your-account',
        revision: BEFORE.revisions.get('your-account')!,
      },
      {
        file: MIGRATION!.name,
        op: 'put',
        slug: 'the-sales-role',
        revision: BEFORE.revisions.get('the-sales-role')!,
      },
    ]);
    expect(HELP.revisions.get('integrations')).toBe(1);
    expect(HELP.revisions.get('forms-and-spam')).toBe(1);
    expect(HELP.revisions.get('your-account')).toBe(BEFORE.revisions.get('your-account')! + 1);
    expect(HELP.revisions.get('the-sales-role')).toBe(BEFORE.revisions.get('the-sales-role')! + 1);
    // Nothing else moved.
    const mine = ['integrations', 'forms-and-spam', 'your-account', 'the-sales-role'];
    const others = (set: typeof HELP.set) => set.filter((g) => !mine.includes(g.slug));
    expect(others(HELP.set)).toEqual(others(BEFORE.set));
  });

  it('each literal is its file in docs/admin-v2/guides, byte for byte', () => {
    const literals = [
      ...MIGRATION!.sql.matchAll(
        /^select app\.put_help_guide\(\$guide\$\r?\n([\s\S]*?)\r?\n\$guide\$::jsonb, \d+\);/gm,
      ),
    ].map((m) => m[1]!);
    expect(literals).toHaveLength(4);
    for (const literal of literals) {
      const slug = (JSON.parse(literal) as { slug: string }).slug;
      expect(literal, slug).toBe(
        readFileSync(`docs/admin-v2/guides/${slug}.json`, 'utf8').replace(/\r?\n$/, ''),
      );
    }
  });

  it('takes two free places: 62 after SEO (60), 85 after personal data (80)', () => {
    expect(guide('integrations').sort_order).toBe(62);
    expect(guide('forms-and-spam').sort_order).toBe(85);
    const places = HELP.set.map((g) => g.sort_order);
    expect(new Set(places).size).toBe(places.length);
  });

  it('each new guide is for the roles that open its screen, and its screen offers it', () => {
    expect(guide('integrations').caps).toEqual(['settings.integrations']);
    expect(guide('integrations').screens).toEqual(['/admin/integrations']);
    expect(readers('integrations')).toEqual(
      ROLES.filter((r) => ROLE_CAPS[r]['settings.integrations'] === 'full'),
    );
    expect(readers('integrations')).toEqual(['admin', 'seo']);
    expect(guide('forms-and-spam').caps).toEqual(['settings.general']);
    expect(guide('forms-and-spam').screens).toEqual(['/admin/forms']);
    expect(readers('forms-and-spam')).toEqual(['admin', 'developer']);
    expect(pageGuideFor('/admin/integrations', 'seo')).toBe('integrations');
    expect(pageGuideFor('/admin/integrations', 'content_creator')).toBeNull();
    expect(pageGuideFor('/admin/forms', 'developer')).toBe('forms-and-spam');
    expect(pageGuideFor('/admin/forms', 'seo')).toBeNull();
  });

  it('your-account names the bell settings screen, which offers it to every member', () => {
    expect(guide('your-account').screens).toEqual([
      '/admin/account',
      '/admin/notifications',
      '/admin/2fa',
      '/admin/settings/notifications',
    ]);
    for (const role of ROLES) {
      expect(pageGuideFor('/admin/settings/notifications', role), role).toBe('your-account');
    }
  });

  it('your-account only gains the bell settings line; its place, title, caps and tags stay', () => {
    const before = HelpArticleSeedSchema.parse(BEFORE.set.find((g) => g.slug === 'your-account'));
    const after = guide('your-account');
    const keep = (g: HelpArticleRow) => [g.sort_order, g.title, g.title_ar, g.caps, g.tags];
    expect(keep(after)).toEqual(keep(before));
    for (const lang of ['en', 'ar'] as const) {
      const flat = (g: HelpArticleRow) =>
        g.body[lang].flatMap((b) => (Array.isArray(b.x) ? b.x : [b.x]));
      const added = flat(after).filter((line) => !flat(before).includes(line));
      expect(added, lang).toHaveLength(1);
      expect(
        flat(before).every((line) => flat(after).includes(line)),
        lang,
      ).toBe(true);
    }
    expect(text('your-account', 'en')).toContain('open Notifications under Settings');
    expect(text('your-account', 'en')).toContain('Turning one off only quiets the bell');
    expect(settings.links.map((l) => l.label)).toContain('Notifications');
  });
});

describe('the-sales-role names the one setting Sales opens (the bell settings, U11)', () => {
  const before = () =>
    HelpArticleSeedSchema.parse(BEFORE.set.find((g) => g.slug === 'the-sales-role'));
  const flat = (g: HelpArticleRow, lang: 'en' | 'ar') =>
    g.body[lang].flatMap((b) => (Array.isArray(b.x) ? b.x : [b.x]));

  it('Sales sees Settings › Notifications in its menu, and nothing else of Settings', () => {
    const groups = visibleNav('sales');
    expect(groups.find((g) => g.title === 'Settings')?.links.map((l) => l.label)).toEqual([
      'Notifications',
    ]);
  });

  it("keeps C10a's place, title, caps and screens; says no site setting, and names its own", () => {
    const keep = (g: HelpArticleRow) => [
      g.sort_order,
      g.title,
      g.title_ar,
      g.caps,
      g.tags,
      g.screens,
    ];
    expect(keep(guide('the-sales-role'))).toEqual(keep(before()));
    const en = text('the-sales-role', 'en');
    const ar = text('the-sales-role', 'ar');
    expect(en).not.toContain('it opens no page, setting,');
    expect(en).toContain('it opens no page, site setting, media or job application');
    expect(en).toContain(
      "Choose what the bell shows in Settings › Notifications. That setting is the account's own, and the only one Sales opens.",
    );
    expect(en).toContain("Change content, the site's settings, people or the theme");
    expect(ar).toContain('لا يفتح الصفحات ولا إعدادات الموقع');
    expect(ar).toContain('Settings › Notifications');
    // One line added in each language, and every other block as C10a left it but the two
    // words that become "site settings".
    for (const lang of ['en', 'ar'] as const) {
      const added = flat(guide('the-sales-role'), lang).filter(
        (line) => !flat(before(), lang).includes(line),
      );
      expect(added, lang).toHaveLength(3);
      expect(
        guide('the-sales-role').body[lang].map((b) => b.t),
        lang,
      ).toEqual(before().body[lang].map((b) => b.t));
    }
    expect(flat(guide('the-sales-role'), 'en')).toHaveLength(flat(before(), 'en').length + 1);
  });
});

describe('the integrations guide says what the screen does', () => {
  const en = () => text('integrations', 'en');
  const ar = () => text('integrations', 'ar');

  it('names every tile and the buttons the screen draws, in both languages', () => {
    const screen =
      source('src/components/admin/screens/integrations/IntegrationsScreen.tsx') +
      source('src/components/admin/screens/integrations/IntegrationDrawer.tsx');
    expect(INTEGRATION_TILES.map((t) => t.name)).toEqual([
      'Google Analytics 4',
      'Google Search Console',
      'Calendly',
      'Captcha',
    ]);
    for (const words of ['Set up', 'Remove', 'Save']) expect(screen, words).toContain(words);
    for (const words of ['Google Search Console', 'Set up', 'Save', 'Remove', 'Verify']) {
      expect(en(), words).toContain(words);
    }
    for (const words of ['Search Console', 'Set up', 'Save', 'Verify', 'Integrations']) {
      expect(ar(), words).toContain(words);
    }
  });

  it('describes each value as its pattern takes it, and says none is a secret', () => {
    expect(en()).toContain('measurement ID that starts with G-');
    expect(GA4_ID.test('G-ABC123XYZ')).toBe(true);
    expect(en()).toContain('starts with https://calendly.com/');
    expect(CALENDLY_URL.test('https://calendly.com/your-name')).toBe(true);
    expect(en()).toContain('paste the whole tag or just the code inside content');
    expect(GSC_TOKEN.source).not.toContain('<');
    expect(en()).toContain('Nothing here is a password or a secret key');
  });

  it('is honest about what is not used yet: GA4 and Calendly are saved, the captcha is not set up', () => {
    expect(en()).toContain('The site does not load Google Analytics yet');
    expect(en()).toContain('only for visitors who accept analytics cookies');
    expect(en()).toContain('No page shows a booking button yet');
    expect(en()).toContain('Not set up yet');
    expect(INTEGRATION_TILES.find((t) => t.key === 'captcha')?.field).toBeNull();
  });
});

describe('the forms guide gives the numbers the code holds', () => {
  const en = () => text('forms-and-spam', 'en');
  const ar = () => text('forms-and-spam', 'ar');

  it('the limits and the CV size, in both languages', () => {
    expect(CONTACT_LIMITS.perIp).toEqual({ max: 10, windowSeconds: 3600 });
    expect(APPLY_LIMITS.perIp).toEqual({ max: 5, windowSeconds: 3600 });
    expect(APPLY_LIMITS.perEmail).toEqual({ max: 3, windowSeconds: 86_400 });
    expect(en()).toContain(
      `up to ${CONTACT_LIMITS.perIp.max} sends an hour from one internet address`,
    );
    expect(en()).toContain(
      `up to ${APPLY_LIMITS.perIp.max} sends an hour from one internet address`,
    );
    expect(en()).toContain(`${APPLY_LIMITS.perEmail.max} a day from one e-mail`);
    expect(CV_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(en()).toContain('up to 10 MB');
    for (const n of ['10', '5', '3']) expect(ar(), n).toContain(n);
  });

  it('what each form needs is what the overview derives from the schemas', () => {
    const facts = formFacts();
    const required = (id: 'inquiry' | 'join') =>
      facts[id].fields.filter((f) => f.required).map((f) => f.key);
    expect(required('inquiry')).toEqual(['name', 'email', 'message']);
    expect(en()).toContain('The inquiry form needs a name, an e-mail and a message.');
    // Every field of the three variants, and the places that ask one when not all do, as
    // the overview marks them (tests/lib/formsOverview.spec.ts holds those to the forms).
    const hint = (key: string) => facts.inquiry.fields.find((f) => f.key === key)?.hint;
    expect(en()).toContain(
      'the inquiry form on the home page, the Contact page and the services pages',
    );
    expect(en()).toContain(
      'The company, a phone number, the service, the budget, when it is needed and the agreement to be contacted are optional.',
    );
    expect(hint('phone')).toBe('Only on the services pages');
    expect(en()).toContain('only the services pages ask for a phone number');
    expect(hint('budgetBand')).toBe('Only on the Contact page and the services pages');
    expect(en()).toContain('the Contact page and the services pages for the budget');
    expect(hint('timelineText')).toBe('Only on the Contact page');
    expect(en()).toContain('only the Contact page for when it is needed');
    expect(ar()).toContain('صفحات الخدمات وحدها تطلب رقم الجوال');
    expect(required('join')).toEqual([
      'name',
      'email',
      'phone',
      'city',
      'role',
      'experience',
      'workType',
      'availability',
      'portfolio',
      'message',
      'consentApplication',
    ]);
    expect(en()).toContain(
      'The Join form needs a name, an e-mail, a phone number, a city, the role, the experience, how the person wants to work, when they could start, a portfolio link, a message and the box that lets you keep the application.',
    );
  });

  it('says where the words around each form are edited, place by place, as the overview does', () => {
    // A service page's "Say hello" block has fixed words (tests/lib/formsOverview.spec.ts
    // holds that to ServicePage.astro): the guide must not send anyone to Pages for it.
    const fixed = 'On each service page those words are fixed, and the heading names the service.';
    expect(formFacts().inquiry.wording).toContain(fixed);
    expect(en()).toContain(fixed);
    expect(en()).toContain(
      'On the home page, the Contact page, the Services page and Join, the words around each form, such as its heading, are edited with that page, in Pages',
    );
    expect(en()).not.toContain('the page that holds it');
    expect(ar()).toContain('أما في صفحة كل خدمة فهذه النصوص ثابتة، ويحمل العنوان اسم الخدمة.');
  });

  it('the fail modes are the routes’ (EXC-004)', () => {
    expect(source('src/lib/http/publicRateLimit.ts')).toContain('the apply path fails CLOSED');
    expect(source('src/lib/http/publicRateLimit.ts')).toContain('the contact form fails');
    expect(en()).toContain('the send still goes through, so no inquiry is lost');
    expect(en()).toContain('the send is refused for now, because it carries a file');
    expect(en()).toContain('A captcha is not set up yet.');
  });
});
