import { describe, it, expect } from 'vitest';
import { resolveSeo, type EntitySeo, type SeoDefaults } from '@/lib/data/seo';
import { DEFAULT_TITLE_TEMPLATE, applyTitleTemplate, siteTitle } from '@/lib/seo/title';
import { AnalyticsEventSchema, ConsentRecordSchema } from '@schemas/analytics';

// The precedence rule the SEO role's whole surface depends on, plus the bounds on the
// two unauthenticated ingest paths added for launch.

const BRAND = 'Braiin Statiion';
const BRAND_AR = 'بريّن ستيشن';

const defaults: SeoDefaults = {
  title_template: { en: '%brand% | %s', ar: '%brand% | %s' },
  default_title: { en: 'Creative studio', ar: 'استوديو إبداعي' },
  default_description: { en: 'Creative agency.', ar: 'وكالة إبداعية.' },
  default_og_image: 'https://cdn.test/default.png',
  robots_directives: 'index,follow',
};

const entity: EntitySeo = {
  meta_title: { en: 'Branding', ar: 'الهوية البصرية' },
  meta_description: { en: 'Identity systems.', ar: 'أنظمة الهوية.' },
  og_image: 'https://cdn.test/branding.png',
  canonical_override: null,
  robots: null,
  schema_type: null,
};

const en = { locale: 'en' as const, brand: BRAND };
const ar = { locale: 'ar' as const, brand: BRAND_AR };

describe('resolveSeo precedence', () => {
  it('prefers the entity override over the page title and the tenant default', () => {
    const seo = resolveSeo({ ...en, entity, defaults, fallbackTitle: 'Fallback' });
    expect(seo.title).toBe('Braiin Statiion | Branding');
    expect(seo.description).toBe('Identity systems.');
    expect(seo.ogImage).toBe('https://cdn.test/branding.png');
  });

  it("ranks the page's own title ABOVE the tenant default title", () => {
    // Before UI v2 the default outranked the page, so authoring one default title gave
    // every service, article and project on the site the same <title>.
    const empty: EntitySeo = { ...entity, meta_title: {}, meta_description: {} };
    const seo = resolveSeo({
      ...en,
      entity: empty,
      defaults,
      fallbackTitle: 'Motion Graphics',
      fallbackDescription: 'Moving type.',
    });
    expect(seo.title).toBe('Braiin Statiion | Motion Graphics');
    expect(seo.description).toBe('Moving type.');
  });

  it('uses the tenant default only when the page has nothing of its own', () => {
    const seo = resolveSeo({ ...en, entity: null, defaults, fallbackTitle: '' });
    expect(seo.title).toBe('Braiin Statiion | Creative studio');
    expect(seo.description).toBe('Creative agency.');
  });

  it('defaults the template to "%brand% | %s" when none is authored', () => {
    expect(resolveSeo({ ...en, entity: null, defaults: null, fallbackTitle: 'About' }).title).toBe(
      'Braiin Statiion | About',
    );
    const blank: SeoDefaults = { ...defaults, title_template: {} };
    expect(resolveSeo({ ...en, entity: null, defaults: blank, fallbackTitle: 'About' }).title).toBe(
      'Braiin Statiion | About',
    );
  });

  it('honours an authored template, with %brand% substituted', () => {
    const custom: SeoDefaults = { ...defaults, title_template: { en: '%s — %brand%' } };
    expect(resolveSeo({ ...en, entity, defaults: custom, fallbackTitle: 'X' }).title).toBe(
      'Branding — Braiin Statiion',
    );
  });

  it('ignores a template without %s rather than giving every page one title', () => {
    const noPlaceholder: SeoDefaults = { ...defaults, title_template: { en: '%brand%' } };
    expect(resolveSeo({ ...en, entity, defaults: noPlaceholder, fallbackTitle: 'X' }).title).toBe(
      'Braiin Statiion | Branding',
    );
  });

  it('never doubles the brand when the title already names it', () => {
    const legacy: EntitySeo = { ...entity, meta_title: { en: 'Branding — Braiin Statiion' } };
    expect(resolveSeo({ ...en, entity: legacy, defaults, fallbackTitle: 'X' }).title).toBe(
      'Branding — Braiin Statiion',
    );
    const tokened: EntitySeo = { ...entity, meta_title: { en: '%brand% for Riyadh Season' } };
    expect(resolveSeo({ ...en, entity: tokened, defaults, fallbackTitle: 'X' }).title).toBe(
      'Braiin Statiion for Riyadh Season',
    );
  });

  it('keeps $-patterns in a CMS title verbatim (no replacement-string expansion)', () => {
    const dollars: EntitySeo = { ...entity, meta_title: { en: "Save $& now, $1 off, $$ and $'" } };
    expect(resolveSeo({ ...en, entity: dollars, defaults, fallbackTitle: 'X' }).title).toBe(
      "Braiin Statiion | Save $& now, $1 off, $$ and $'",
    );
  });

  it('substitutes %brand% in descriptions too', () => {
    const seo = resolveSeo({
      ...en,
      entity: null,
      defaults: null,
      fallbackTitle: 'About',
      fallbackDescription: 'Meet %brand%.',
    });
    expect(seo.description).toBe('Meet Braiin Statiion.');
  });

  it('uses the Arabic strings (and the Arabic brand) on an Arabic page', () => {
    const seo = resolveSeo({ ...ar, entity, defaults, fallbackTitle: 'X' });
    expect(seo.title).toBe('بريّن ستيشن | الهوية البصرية');
    expect(seo.description).toBe('أنظمة الهوية.');
  });

  it('NEVER falls back from Arabic to English metadata', () => {
    // Body copy falls back; metadata must not. The page declares lang="ar" and
    // og:locale=ar_SA, so an English description under those signals is a worse input
    // to a search engine than none — and '' makes SeoHead omit the tag entirely.
    const enOnly: EntitySeo = {
      ...entity,
      meta_title: { en: 'Branding' },
      meta_description: { en: 'Identity systems.' },
    };
    const bareDefaults: SeoDefaults = {
      ...defaults,
      title_template: {},
      default_title: {},
      default_description: {},
    };
    const seo = resolveSeo({
      ...ar,
      entity: enOnly,
      defaults: bareDefaults,
      fallbackTitle: 'خدمة',
    });
    expect(seo.title).toBe('بريّن ستيشن | خدمة');
    expect(seo.description).toBe('');
  });

  it('yields the brand alone when there is no title anywhere', () => {
    expect(resolveSeo({ ...en, entity: null, defaults: null, fallbackTitle: '' }).title).toBe(
      'Braiin Statiion',
    );
  });

  it('carries robots and canonical overrides through', () => {
    const overridden: EntitySeo = {
      ...entity,
      robots: 'noindex,follow',
      canonical_override: 'https://www.braiinstation.com/services/branding',
    };
    const seo = resolveSeo({ ...en, entity: overridden, defaults, fallbackTitle: 'X' });
    expect(seo.robots).toBe('noindex,follow');
    expect(seo.canonicalOverride).toBe('https://www.braiinstation.com/services/branding');
  });

  it('defaults robots to index,follow when nothing is authored', () => {
    expect(resolveSeo({ ...en, entity: null, defaults: null, fallbackTitle: 'X' }).robots).toBe(
      'index,follow',
    );
  });
});

describe('title template helpers', () => {
  it('siteTitle is the default format', () => {
    expect(siteTitle('Contact us', BRAND)).toBe('Braiin Statiion | Contact us');
    expect(siteTitle('تواصل معنا', BRAND_AR)).toBe('بريّن ستيشن | تواصل معنا');
  });

  it('the brand check is case-insensitive', () => {
    expect(applyTitleTemplate(DEFAULT_TITLE_TEMPLATE, 'about BRAIIN STATIION', BRAND)).toBe(
      'about BRAIIN STATIION',
    );
  });
});

describe('analytics ingest bounds', () => {
  it('accepts a well-formed pageview', () => {
    expect(
      AnalyticsEventSchema.safeParse({ type: 'pageview', path: '/services', locale: 'en' }).success,
    ).toBe(true);
  });

  it('rejects an unknown event type', () => {
    // Closed set: an open event_type produces rows no dashboard reads and no retention
    // rule anticipates.
    expect(AnalyticsEventSchema.safeParse({ type: 'exfiltrate', path: '/' }).success).toBe(false);
  });

  it('rejects an absolute URL or a query string as the path', () => {
    expect(
      AnalyticsEventSchema.safeParse({ type: 'pageview', path: 'https://evil.test' }).success,
    ).toBe(false);
    expect(
      AnalyticsEventSchema.safeParse({ type: 'pageview', path: '/a?token=secret' }).success,
    ).toBe(false);
    expect(AnalyticsEventSchema.safeParse({ type: 'pageview', path: '/a#frag' }).success).toBe(
      false,
    );
  });

  it('bounds the payload — this is an unauthenticated write path', () => {
    expect(
      AnalyticsEventSchema.safeParse({ type: 'pageview', path: `/${'x'.repeat(600)}` }).success,
    ).toBe(false);
    expect(
      AnalyticsEventSchema.safeParse({ type: 'pageview', sessionId: 'x'.repeat(100) }).success,
    ).toBe(false);
    const tooManyProps = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, 'v']));
    expect(AnalyticsEventSchema.safeParse({ type: 'pageview', props: tooManyProps }).success).toBe(
      false,
    );
  });

  it('rejects a session id that is not opaque', () => {
    expect(
      AnalyticsEventSchema.safeParse({ type: 'pageview', sessionId: '<script>' }).success,
    ).toBe(false);
  });
});

describe('consent record', () => {
  it('requires all three categories to be stated explicitly', () => {
    expect(
      ConsentRecordSchema.safeParse({
        categories: { functional: true, analytics: false, marketing: false },
        policyVersion: '1',
      }).success,
    ).toBe(true);
    // A partial record cannot prove what was consented to, which is the whole point of
    // the ledger.
    expect(
      ConsentRecordSchema.safeParse({ categories: { analytics: true }, policyVersion: '1' })
        .success,
    ).toBe(false);
  });

  it('accepts withdrawal as a first-class action', () => {
    const parsed = ConsentRecordSchema.safeParse({
      categories: { functional: true, analytics: false, marketing: false },
      policyVersion: '1',
      action: 'withdraw',
    });
    expect(parsed.success && parsed.data.action).toBe('withdraw');
  });
});
