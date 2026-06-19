import { describe, it, expect } from 'vitest';
import {
  buildServiceSchema,
  buildBreadcrumbSchema,
  buildOrganizationSchema,
  buildCreativeWorkSchema,
  buildPersonSchema,
  buildArticleSchema,
} from '@/lib/seo/jsonld';

describe('JSON-LD builders', () => {
  it('Service carries the required fields + Organization provider', () => {
    const s = buildServiceSchema({
      name: 'Branding',
      description: 'Identity systems.',
      url: 'https://x/services/branding',
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
    expect(buildOrganizationSchema('https://x')['@context']).toBe('https://schema.org');
  });

  it('Person carries name + worksFor, omits empty optional fields', () => {
    const p = buildPersonSchema({ name: 'Creative Director' });
    expect(p['@type']).toBe('Person');
    expect(p.name).toBe('Creative Director');
    expect((p.worksFor as { '@type': string })['@type']).toBe('Organization');
    expect(p.description).toBeUndefined();
    expect(p.image).toBeUndefined();
  });

  it('Person includes optional fields when provided', () => {
    const p = buildPersonSchema({
      name: 'Head of Video',
      description: 'Oversees film and motion.',
      image: 'https://x/a.jpg',
    });
    expect(p.description).toBe('Oversees film and motion.');
    expect(p.image).toBe('https://x/a.jpg');
  });

  it('Article (BlogPosting) carries named Person author + truthful dates when provided', () => {
    const a = buildArticleSchema({
      headline: 'Arabic-first brand systems',
      description: 'Why Arabic-first wins.',
      url: 'https://x/creative-knowledge/arabic-first',
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
    const a = buildArticleSchema({ headline: 'H', description: 'D', url: 'https://x/ck/h' });
    expect((a.author as { '@type': string })['@type']).toBe('Organization');
    expect(a.datePublished).toBeUndefined();
    expect(a.image).toBeUndefined();
  });

  it('CreativeWork carries the required fields + Organization creator', () => {
    const w = buildCreativeWorkSchema({
      name: 'Riyadh Season Launch',
      description: 'A full-funnel campaign.',
      url: 'https://x/portfolio/riyadh-season-launch',
    });
    expect(w['@type']).toBe('CreativeWork');
    expect(w.name).toBe('Riyadh Season Launch');
    expect((w.creator as { '@type': string })['@type']).toBe('Organization');
  });
});
