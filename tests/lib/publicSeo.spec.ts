import { describe, it, expect } from 'vitest';
import { resolveSeo, type EntitySeo, type SeoDefaults } from '@/lib/data/seo';
import { AnalyticsEventSchema, ConsentRecordSchema } from '@schemas/analytics';

// The precedence rule the SEO role's whole surface depends on, plus the bounds on the
// two unauthenticated ingest paths added for launch.

const defaults: SeoDefaults = {
  title_template: { en: '%s | Braiin Station', ar: '%s | بريـن ستيشن' },
  default_title: { en: 'Braiin Station', ar: 'بريـن ستيشن' },
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

describe('resolveSeo precedence', () => {
  it('prefers the entity override over the tenant default', () => {
    const seo = resolveSeo({ locale: 'en', entity, defaults, fallbackTitle: 'Fallback' });
    expect(seo.title).toBe('Branding | Braiin Station');
    expect(seo.description).toBe('Identity systems.');
    expect(seo.ogImage).toBe('https://cdn.test/branding.png');
  });

  it('falls back to the tenant default, then to the content title', () => {
    const empty: EntitySeo = { ...entity, meta_title: {}, meta_description: {} };
    expect(resolveSeo({ locale: 'en', entity: empty, defaults, fallbackTitle: 'X' }).title).toBe(
      'Braiin Station | Braiin Station',
    );
    expect(
      resolveSeo({ locale: 'en', entity: null, defaults: null, fallbackTitle: 'Service X' }).title,
    ).toBe('Service X');
  });

  it('applies the template only when it contains %s', () => {
    const noPlaceholder: SeoDefaults = { ...defaults, title_template: { en: 'Braiin Station' } };
    // A template authored without the placeholder must not silently discard the page
    // title — every page would end up with the same <title>.
    expect(
      resolveSeo({ locale: 'en', entity, defaults: noPlaceholder, fallbackTitle: 'X' }).title,
    ).toBe('Branding');
  });

  it('uses the Arabic strings on an Arabic page', () => {
    const seo = resolveSeo({ locale: 'ar', entity, defaults, fallbackTitle: 'X' });
    expect(seo.title).toBe('الهوية البصرية | بريـن ستيشن');
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
      locale: 'ar',
      entity: enOnly,
      defaults: bareDefaults,
      fallbackTitle: 'خدمة',
    });
    expect(seo.title).toBe('خدمة');
    expect(seo.description).toBe('');
  });

  it('carries robots and canonical overrides through', () => {
    const overridden: EntitySeo = {
      ...entity,
      robots: 'noindex,follow',
      canonical_override: 'https://www.braiinstation.com/services/branding',
    };
    const seo = resolveSeo({ locale: 'en', entity: overridden, defaults, fallbackTitle: 'X' });
    expect(seo.robots).toBe('noindex,follow');
    expect(seo.canonicalOverride).toBe('https://www.braiinstation.com/services/branding');
  });

  it('defaults robots to index,follow when nothing is authored', () => {
    expect(
      resolveSeo({ locale: 'en', entity: null, defaults: null, fallbackTitle: 'X' }).robots,
    ).toBe('index,follow');
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
