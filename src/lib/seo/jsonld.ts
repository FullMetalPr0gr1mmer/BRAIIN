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
