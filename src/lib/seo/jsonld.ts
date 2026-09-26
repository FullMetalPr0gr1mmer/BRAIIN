// JSON-LD builders (CLAUDE.md Pillar 3). Output is emitted only through <JsonLd>
// and validated per entity type in CI (EN + AR).
//
// The organisation is DATA (`site_profile`, via getIdentity()): no builder names the
// brand itself. Nodes that attribute work to the studio (Service.provider,
// Person.worksFor, CreativeWork.creator, BlogPosting.publisher) take an `org` reference
// built by `orgRef()`, so a rename in the CMS reaches every structured-data node on the
// next render — the old hard-coded ORG_NAME is exactly how "Braiin Station" would have
// outlived the rename in search results.

import type { Locale } from '@schemas/primitives';
import type { Identity } from '@/lib/identity/fallback';

export type JsonLdNode = Record<string, unknown>;

/** The studio as the subject of an attribution. */
export interface OrgRef {
  name: string;
}

export function orgRef(identity: Identity, locale: Locale): OrgRef {
  return { name: identity.brandName[locale] };
}

const orgNode = (org: OrgRef): JsonLdNode => ({ '@type': 'Organization', name: org.name });

/**
 * Organization — the sitewide identity node (home). Every field comes from the public
 * identity, and each optional one is emitted only when it has a real value.
 *
 * `logo` is deliberately ABSENT. It pointed at /logo.svg, which has never existed: a logo
 * URL that 404s is a structured-data error, not a missing enhancement. The only logo
 * asset today is white-on-transparent, which renders invisibly on the white tile search
 * engines display it on. It returns with a proper square asset (open owner item).
 */
export function buildOrganizationSchema(
  siteUrl: string,
  identity: Identity,
  locale: Locale,
): JsonLdNode {
  const base = siteUrl.replace(/\/$/, '');
  const other: Locale = locale === 'ar' ? 'en' : 'ar';
  const node: JsonLdNode = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: identity.brandName[locale],
    alternateName: identity.brandName[other],
    url: base,
    email: identity.contactEmail,
  };
  if (identity.legalName) node.legalName = identity.legalName[locale];
  if (identity.foundedYear) node.foundingDate = String(identity.foundedYear);
  node.address = {
    '@type': 'PostalAddress',
    ...(identity.addressLocality ? { addressLocality: identity.addressLocality[locale] } : {}),
    addressCountry: identity.addressCountry,
  };
  // Socials were re-validated against the per-network host allow-list on read
  // (SiteProfileRowSchema), so every URL here points at the network it claims.
  if (identity.socials.length > 0) node.sameAs = identity.socials.map((s) => s.url);
  return node;
}

export function buildWebSiteSchema(siteUrl: string, org: OrgRef): JsonLdNode {
  const base = siteUrl.replace(/\/$/, '');
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: org.name,
    url: base,
    inLanguage: ['en', 'ar'],
  };
}

export function buildServiceSchema(opts: {
  name: string;
  description: string;
  url: string;
  org: OrgRef;
}): JsonLdNode {
  return {
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: opts.name,
    description: opts.description,
    url: opts.url,
    provider: orgNode(opts.org),
    areaServed: 'SA',
  };
}

export function buildPersonSchema(opts: {
  name: string;
  org: OrgRef;
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
    worksFor: orgNode(opts.org),
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
  org: OrgRef;
}): JsonLdNode {
  return {
    '@context': 'https://schema.org',
    '@type': 'CreativeWork',
    name: opts.name,
    description: opts.description,
    url: opts.url,
    creator: orgNode(opts.org),
  };
}

export function buildArticleSchema(opts: {
  headline: string;
  description: string;
  url: string;
  org: OrgRef;
  authorName?: string;
  datePublished?: string;
  dateModified?: string;
  image?: string;
}): JsonLdNode {
  // BlogPosting for Creative Knowledge articles (CLAUDE.md Pillar 3). Named author
  // (E-E-A-T, no anonymous authorship); truthful dates. Optional fields emitted only
  // when present to stay CI-valid.
  const node: JsonLdNode = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: opts.headline,
    description: opts.description,
    url: opts.url,
    publisher: orgNode(opts.org),
    author: opts.authorName ? { '@type': 'Person', name: opts.authorName } : orgNode(opts.org),
  };
  if (opts.datePublished) node.datePublished = opts.datePublished;
  if (opts.dateModified) node.dateModified = opts.dateModified;
  if (opts.image) node.image = opts.image;
  return node;
}

/**
 * FAQPage — the 8th of the eight types CLAUDE.md Pillar 3 requires (the other seven were
 * built; this one was missed). It is the AEO-load-bearing one: `Question`/`acceptedAnswer`
 * pairs are the structure answer engines lift verbatim when citing a source, which is the
 * whole point of the GEO/AEO pillar. Phase 2 scopes an FAQ block on the article system.
 *
 * Answers are plain text, not HTML: Google ignores markup here, and passing sanitised
 * Tiptap HTML through would put author-controlled markup into a `<script>` block. The
 * caller strips tags; this builder accepts text only (Pillar 1 — sanitise on render).
 */
export function buildFaqSchema(items: { question: string; answer: string }[]): JsonLdNode {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((it) => ({
      '@type': 'Question',
      name: it.question,
      acceptedAnswer: { '@type': 'Answer', text: it.answer },
    })),
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
