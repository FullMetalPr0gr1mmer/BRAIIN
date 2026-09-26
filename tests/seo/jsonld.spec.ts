import { describe, it, expect } from 'vitest';
import {
  buildServiceSchema,
  buildBreadcrumbSchema,
  buildOrganizationSchema,
  buildCreativeWorkSchema,
  buildPersonSchema,
  buildArticleSchema,
  buildFaqSchema,
  buildWebSiteSchema,
  orgRef,
} from '@/lib/seo/jsonld';
import { IDENTITY_FALLBACK, type Identity } from '@/lib/identity/fallback';

const org = { name: 'Braiin Statiion' };

describe('JSON-LD builders', () => {
  it('Service carries the required fields + Organization provider', () => {
    const s = buildServiceSchema({
      name: 'Branding',
      description: 'Identity systems.',
      url: 'https://x/services/branding',
      org,
    });
    expect(s['@type']).toBe('Service');
    expect(s.name).toBe('Branding');
    expect((s.provider as { '@type': string })['@type']).toBe('Organization');
  });

  it('BreadcrumbList positions are 1-based and ordered', () => {
    const b = buildBreadcrumbSchema([
      { name: 'Home', url: 'https://x/' },
      { name: 'Services', url: 'https://x/services' },
    ]);
    expect(b['@type']).toBe('BreadcrumbList');
    const items = b.itemListElement as Array<{ position: number; name: string }>;
    expect(items.map((i) => i.position)).toEqual([1, 2]);
    expect(items[0]?.name).toBe('Home');
  });

  it('Organization @context is schema.org', () => {
    expect(buildOrganizationSchema('https://x', IDENTITY_FALLBACK, 'en')['@context']).toBe(
      'https://schema.org',
    );
  });

  it('Organization is built from the public identity, in the page language', () => {
    const o = buildOrganizationSchema('https://x/', IDENTITY_FALLBACK, 'en');
    expect(o.name).toBe('Braiin Statiion');
    expect(o.alternateName).toBe('بريّن ستيشن');
    expect(o.url).toBe('https://x');
    expect(o.email).toBe('hello@braiinstatiion.com');
    expect(o.foundingDate).toBe('2019');
    expect(o.sameAs).toEqual(IDENTITY_FALLBACK.socials.map((s) => s.url));
    expect(o.address).toEqual({
      '@type': 'PostalAddress',
      addressLocality: 'Jeddah',
      addressCountry: 'SA',
    });
    // /logo.svg never existed — a logo URL that 404s is a structured-data error.
    expect(o.logo).toBeUndefined();

    const a = buildOrganizationSchema('https://x', IDENTITY_FALLBACK, 'ar');
    expect(a.name).toBe('بريّن ستيشن');
    expect(a.alternateName).toBe('Braiin Statiion');
    expect((a.address as { addressLocality: string }).addressLocality).toBe('جدة');
  });

  it('Organization omits what the identity does not have', () => {
    const bare: Identity = {
      ...IDENTITY_FALLBACK,
      legalName: null,
      addressLocality: null,
      foundedYear: null,
      socials: [],
    };
    const o = buildOrganizationSchema('https://x', bare, 'en');
    expect(o.legalName).toBeUndefined();
    expect(o.foundingDate).toBeUndefined();
    expect(o.sameAs).toBeUndefined();
    expect(o.address).toEqual({ '@type': 'PostalAddress', addressCountry: 'SA' });

    const named = buildOrganizationSchema(
      'https://x',
      { ...bare, legalName: { en: 'Braiin Statiion LLC', ar: 'شركة بريّن ستيشن' } },
      'ar',
    );
    expect(named.legalName).toBe('شركة بريّن ستيشن');
  });

  it('every attribution names the studio from the identity, never a constant', () => {
    const renamed = orgRef(
      { ...IDENTITY_FALLBACK, brandName: { en: 'New Name', ar: 'اسم' } },
      'en',
    );
    const nodes = [
      buildServiceSchema({ name: 'n', description: 'd', url: 'https://x/s', org: renamed })
        .provider,
      buildPersonSchema({ name: 'n', org: renamed }).worksFor,
      buildCreativeWorkSchema({ name: 'n', description: 'd', url: 'https://x/p', org: renamed })
        .creator,
      buildArticleSchema({ headline: 'h', description: 'd', url: 'https://x/a', org: renamed })
        .publisher,
      buildWebSiteSchema('https://x', renamed),
    ] as Array<{ name: string }>;
    for (const n of nodes) expect(n.name).toBe('New Name');
    expect(orgRef(IDENTITY_FALLBACK, 'ar').name).toBe('بريّن ستيشن');
  });

  it('Person carries name + worksFor, omits empty optional fields', () => {
    const p = buildPersonSchema({ name: 'Creative Director', org });
    expect(p['@type']).toBe('Person');
    expect(p.name).toBe('Creative Director');
    expect((p.worksFor as { '@type': string })['@type']).toBe('Organization');
    expect(p.description).toBeUndefined();
    expect(p.image).toBeUndefined();
  });

  it('Person includes optional fields when provided', () => {
    const p = buildPersonSchema({
      name: 'Head of Video',
      org,
      description: 'Oversees film and motion.',
      image: 'https://x/a.jpg',
    });
    expect(p.description).toBe('Oversees film and motion.');
    expect(p.image).toBe('https://x/a.jpg');
  });

  it('Person carries jobTitle and sameAs for the About leadership (UI v2 PR8)', () => {
    const p = buildPersonSchema({
      name: 'Jane Doe',
      org,
      jobTitle: 'Creative Director',
      sameAs: ['https://linkedin.com/in/jane'],
    });
    expect(p.jobTitle).toBe('Creative Director');
    expect(p.sameAs).toEqual(['https://linkedin.com/in/jane']);
    const bare = buildPersonSchema({ name: 'Jane Doe', org, jobTitle: '', sameAs: [] });
    expect('jobTitle' in bare).toBe(false);
    expect('sameAs' in bare).toBe(false);
  });

  it('Article (BlogPosting) carries named Person author + truthful dates when provided', () => {
    const a = buildArticleSchema({
      headline: 'Arabic-first brand systems',
      description: 'Why Arabic-first wins.',
      url: 'https://x/creative-knowledge/arabic-first',
      org,
      authorName: 'Creative Director',
      datePublished: '2026-06-10T09:00:00Z',
      dateModified: '2026-06-12T09:00:00Z',
    });
    expect(a['@type']).toBe('BlogPosting');
    expect((a.author as { '@type': string; name: string })['@type']).toBe('Person');
    expect((a.author as { name: string }).name).toBe('Creative Director');
    expect(a.datePublished).toBe('2026-06-10T09:00:00Z');
    expect(a.dateModified).toBe('2026-06-12T09:00:00Z');
  });

  it('Article falls back to Organization author and omits absent dates', () => {
    const a = buildArticleSchema({ headline: 'H', description: 'D', url: 'https://x/ck/h', org });
    expect((a.author as { '@type': string })['@type']).toBe('Organization');
    expect(a.datePublished).toBeUndefined();
    expect(a.image).toBeUndefined();
  });

  it('CreativeWork carries the required fields + Organization creator', () => {
    const w = buildCreativeWorkSchema({
      name: 'Riyadh Season Launch',
      description: 'A full-funnel campaign.',
      url: 'https://x/portfolio/riyadh-season-launch',
      org,
    });
    expect(w['@type']).toBe('CreativeWork');
    expect(w.name).toBe('Riyadh Season Launch');
    expect((w.creator as { '@type': string })['@type']).toBe('Organization');
  });

  it('FAQPage nests Question/acceptedAnswer pairs (the AEO citation shape)', () => {
    const f = buildFaqSchema([
      { question: 'How long does a brand identity take?', answer: 'Typically six to eight weeks.' },
      { question: 'Do you work in Arabic?', answer: 'Yes — Arabic-first, not translated.' },
    ]);
    expect(f['@type']).toBe('FAQPage');
    const qs = f.mainEntity as Array<{
      '@type': string;
      name: string;
      acceptedAnswer: { '@type': string; text: string };
    }>;
    expect(qs).toHaveLength(2);
    expect(qs[0]?.['@type']).toBe('Question');
    expect(qs[0]?.acceptedAnswer['@type']).toBe('Answer');
    expect(qs[0]?.acceptedAnswer.text).toBe('Typically six to eight weeks.');
  });

  it('FAQPage carries Arabic answers verbatim (AR is first-class, not translated-on-render)', () => {
    const f = buildFaqSchema([{ question: 'هل تعملون بالعربية؟', answer: 'نعم، بالعربية أولاً.' }]);
    const qs = f.mainEntity as Array<{ name: string; acceptedAnswer: { text: string } }>;
    expect(qs[0]?.name).toBe('هل تعملون بالعربية؟');
    expect(qs[0]?.acceptedAnswer.text).toBe('نعم، بالعربية أولاً.');
  });

  // Exhaustiveness gate. CLAUDE.md Pillar 3 requires EIGHT JSON-LD types; seven shipped
  // and FAQPage — the one answer engines actually lift — was missing, with every
  // individual builder test passing. A per-builder suite cannot catch an ABSENT builder,
  // so this asserts the SET. Adding a required type means updating this list on purpose.
  it('emits all eight required JSON-LD types (CLAUDE.md Pillar 3)', () => {
    const emitted = [
      buildOrganizationSchema('https://x', IDENTITY_FALLBACK, 'en'),
      buildWebSiteSchema('https://x', org),
      buildServiceSchema({ name: 'n', description: 'd', url: 'https://x/s', org }),
      buildPersonSchema({ name: 'n', org }),
      buildCreativeWorkSchema({ name: 'n', description: 'd', url: 'https://x/p', org }),
      buildArticleSchema({ headline: 'h', description: 'd', url: 'https://x/a', org }),
      buildFaqSchema([{ question: 'q', answer: 'a' }]),
      buildBreadcrumbSchema([{ name: 'Home', url: 'https://x/' }]),
    ].map((n) => n['@type']);

    expect(new Set(emitted)).toEqual(
      new Set([
        'Organization',
        'WebSite',
        'Service',
        'Person',
        'CreativeWork',
        'BlogPosting',
        'FAQPage',
        'BreadcrumbList',
      ]),
    );
    expect(emitted).toHaveLength(8);
  });
});
