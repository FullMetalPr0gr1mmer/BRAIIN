import type { SingletonUi } from './types';

// Global SEO defaults: one row per tenant, the form at /admin/seo.
export const seoUi: SingletonUi = {
  endpoint: '/api/admin/seo-defaults',
  title: 'Global SEO defaults',
  fields: [
    {
      name: 'titleTemplate',
      label: 'Title template',
      kind: 'bilingual',
      column: 'title_template',
      help: 'Use %s for the page title and %brand% for the studio name (from Public identity), e.g. “%brand% | %s”. Left empty, the site uses exactly that format.',
    },
    {
      name: 'defaultTitle',
      label: 'Default title',
      kind: 'bilingual',
      column: 'default_title',
      help: 'Only for a page with no title of its own — a page’s own title always wins.',
    },
    {
      name: 'defaultDescription',
      label: 'Default description',
      kind: 'bilingual',
      column: 'default_description',
    },
    {
      name: 'defaultOgImage',
      label: 'Default OG image',
      kind: 'url',
      column: 'default_og_image',
      help: 'The link-preview image for pages with no image of their own — a service’s poster, a case study’s banner or a post’s cover always wins. An https:// URL to an image about 1200×630. Empty: the built-in logo card.',
    },
    {
      name: 'organization',
      label: 'Organization JSON-LD',
      kind: 'json',
      help: 'Deprecated — no longer read by the site. The Organization schema is built from Settings → Public identity (brand, email, location, socials).',
    },
    {
      name: 'robotsDirectives',
      label: 'Robots directives',
      kind: 'text',
      column: 'robots_directives',
    },
  ],
};
