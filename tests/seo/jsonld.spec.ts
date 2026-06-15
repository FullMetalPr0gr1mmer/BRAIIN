import { describe, it, expect } from 'vitest';
import {
  buildServiceSchema,
  buildBreadcrumbSchema,
  buildOrganizationSchema,
  buildCreativeWorkSchema,
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
