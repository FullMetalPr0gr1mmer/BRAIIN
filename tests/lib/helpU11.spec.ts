import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HelpArticleSeedSchema, type HelpArticleRow } from '@schemas/help';
import { CALENDLY_URL, GA4_ID, GSC_TOKEN } from '@schemas/integrations';
import { CV_MAX_BYTES } from '@schemas/application';
import { ROLES } from '@/lib/auth/types';
import { ROLE_CAPS } from '@/lib/authz/matrix';
import { mayRead, pageGuideFor } from '@/lib/admin/help';
import { settings } from '@/lib/admin/nav/settings';
import { INTEGRATION_TILES } from '@/lib/admin/integrations/tiles';
import { formFacts } from '@/lib/admin/forms/overview';
import { APPLY_LIMITS, CONTACT_LIMITS } from '@/lib/http/publicRateLimit';
import { helpSet, readMigrations } from '../fixtures/helpSet';

// The guides Admin v2 U11 puts through H11's catalog (one app.put_help_guide each, in the
// integrations migration, numbered at merge): `integrations` and `forms-and-spam`, new, and
// `your-account` again, for the bell's settings screen. Each is held to its file in
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
  it('puts exactly three, each at the revision the migrations before it leave', () => {
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
    ]);
    expect(HELP.revisions.get('integrations')).toBe(1);
    expect(HELP.revisions.get('forms-and-spam')).toBe(1);
    expect(HELP.revisions.get('your-account')).toBe(BEFORE.revisions.get('your-account')! + 1);
    // Nothing else moved.
    const others = (set: typeof HELP.set) =>
      set.filter((g) => !['integrations', 'forms-and-spam', 'your-account'].includes(g.slug));
    expect(others(HELP.set)).toEqual(others(BEFORE.set));
  });

  it('each literal is its file in docs/admin-v2/guides, byte for byte', () => {
    const literals = [
      ...MIGRATION!.sql.matchAll(
        /^select app\.put_help_guide\(\$guide\$\r?\n([\s\S]*?)\r?\n\$guide\$::jsonb, \d+\);/gm,
      ),
    ].map((m) => m[1]!);
    expect(literals).toHaveLength(3);
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

  it('the fail modes are the routes’ (EXC-004)', () => {
    expect(source('src/lib/http/publicRateLimit.ts')).toContain('the apply path fails CLOSED');
    expect(source('src/lib/http/publicRateLimit.ts')).toContain('the contact form fails');
    expect(en()).toContain('the send still goes through, so no inquiry is lost');
    expect(en()).toContain('the send is refused for now, because it carries a file');
    expect(en()).toContain('A captcha is not set up yet.');
  });
});
