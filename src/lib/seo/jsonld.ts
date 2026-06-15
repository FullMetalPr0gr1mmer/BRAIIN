// JSON-LD builders (CLAUDE.md Pillar 3). Output is emitted only through <JsonLd>
// and validated per entity type in CI (EN + AR). Phase 0 ships Organization +
// WebSite; Service/Article/FAQ/Breadcrumb/CreativeWork/Speakable land with their
// content types in later phases.

export type JsonLdNode = Record<string, unknown>;

const ORG_NAME = 'Braiin Station';

export function buildOrganizationSchema(siteUrl: string): JsonLdNode {
  const base = siteUrl.replace(/\/$/, '');
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: ORG_NAME,
    url: base,
    logo: `${base}/logo.svg`,
  };
}

export function buildWebSiteSchema(siteUrl: string): JsonLdNode {
  const base = siteUrl.replace(/\/$/, '');
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: ORG_NAME,
    url: base,
    inLanguage: ['en', 'ar'],
  };
}

export function buildServiceSchema(opts: {
  name: string;
  description: string;
  url: string;
}): JsonLdNode {
  return {
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: opts.name,
    description: opts.description,
    url: opts.url,
    provider: { '@type': 'Organization', name: ORG_NAME },
    areaServed: 'SA',
  };
}

export function buildPersonSchema(opts: {
  name: string;
  description?: string;
  url?: string;
  image?: string;
}): JsonLdNode {
  // E-E-A-T authorship (CLAUDE.md Pillar 3 — no anonymous authorship). Only emit
  // optional fields when present to keep the node clean + CI-valid.
  const node: JsonLdNode = {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: opts.name,
    worksFor: { '@type': 'Organization', name: ORG_NAME },
  };
  if (opts.description) node.description = opts.description;
  if (opts.url) node.url = opts.url;
  if (opts.image) node.image = opts.image;
  return node;
}

export function buildCreativeWorkSchema(opts: {
  name: string;
  description: string;
  url: string;
}): JsonLdNode {
  return {
    '@context': 'https://schema.org',
    '@type': 'CreativeWork',
    name: opts.name,
    description: opts.description,
    url: opts.url,
    creator: { '@type': 'Organization', name: ORG_NAME },
  };
}

export function buildBreadcrumbSchema(items: { name: string; url: string }[]): JsonLdNode {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: it.url,
    })),
  };
}
