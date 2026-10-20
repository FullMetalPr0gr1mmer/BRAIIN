import { PAGE_PATHS } from '@/lib/visibility/routes';

// Where each kind of SEO target lives on the public site, as a LOGICAL path (no `/ar`; the
// Arabic twin is `/ar` + it): one place for the SEO list's previews, the sitemap's
// indexability filter and the canonical rule "an override equal to the page's own path is
// no override" (Admin v2 U10 D6, D8, D17). Pure: the admin and the public routes import it.

export type SeoEntityType = 'service' | 'blog_post' | 'portfolio' | 'page';

/** A CMS page's slug → its path, or null for a page no public route renders. */
export function pagePath(slug: string): string | null {
  return Object.hasOwn(PAGE_PATHS, slug) ? PAGE_PATHS[slug as keyof typeof PAGE_PATHS] : null;
}

/** The public path of an SEO target, or null when it has none. */
export function entityPath(type: SeoEntityType, slug: string | null | undefined): string | null {
  if (!slug) return null;
  switch (type) {
    case 'service':
      return `/services/${slug}`;
    case 'portfolio':
      return `/portfolio/${slug}`;
    case 'blog_post':
      return `/creative-knowledge/${slug}`;
    case 'page':
      return pagePath(slug);
  }
}
