import type { FieldDef, SingletonUi } from './types';

// Global SEO defaults: one row per tenant, the "Site wide" tab of /admin/seo (Admin v2 U10).
// The share image is a picture from the media library (0073); the legacy image link is
// shown only while one is stored (SeoSiteWide drops it otherwise), so it can be cleared but
// never newly set. `organization` is no longer offered (it was "no longer read": the
// Organization schema is built from the public identity); its column stays.

/** The default robots choices (SEO_DEFAULT_ROBOTS, packages/schemas/admin.ts), in words. */
export const DEFAULT_ROBOTS_OPTIONS = [
  { value: 'index,follow', label: 'Show the site in search results' },
  { value: 'noindex,follow', label: 'Hide every page from search results' },
  { value: 'noindex,nofollow', label: 'Hide every page, and do not follow its links' },
] as const;

/** The legacy share-image link, shown only while one is stored. */
export const LEGACY_DEFAULT_OG_IMAGE: FieldDef = {
  name: 'defaultOgImage',
  label: 'Image link set before',
  kind: 'url',
  column: 'default_og_image',
  help: 'An image link from before the media library. The picture above wins when both are set. Clear this box to stop using the link.',
};

export const seoUi: SingletonUi = {
  endpoint: '/api/admin/seo-defaults',
  title: 'Site wide SEO',
  fields: [
    {
      name: 'titleTemplate',
      label: 'Title template',
      kind: 'bilingual',
      column: 'title_template',
      help: 'Use %s for the page title and %brand% for the studio name (from Public identity), for example “%brand% | %s”. Left empty, the site uses exactly that format.',
    },
    {
      name: 'defaultTitle',
      label: 'Default title',
      kind: 'bilingual',
      column: 'default_title',
      help: 'Only for a page with no title of its own. A page’s own title always wins.',
    },
    {
      name: 'defaultDescription',
      label: 'Default description',
      kind: 'bilingual',
      column: 'default_description',
    },
    {
      name: 'defaultOgMediaId',
      label: 'Default share image',
      kind: 'media',
      column: 'default_og_media_id',
      help: 'Used when a page has no image of its own: a service’s poster, a project’s banner or a post’s cover always wins. Empty: the built-in logo card.',
    },
    LEGACY_DEFAULT_OG_IMAGE,
    {
      name: 'robotsDirectives',
      label: 'Search engines',
      kind: 'select',
      column: 'robots_directives',
      options: DEFAULT_ROBOTS_OPTIONS,
      help: 'Each page can choose for itself on the Pages tab. Hiding every page asks you to confirm by typing noindex.',
    },
  ],
};
