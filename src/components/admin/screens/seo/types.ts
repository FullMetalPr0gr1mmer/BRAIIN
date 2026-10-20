// The SEO screen's shapes in the browser (Admin v2 U10). The list's answer and the panel's
// setup are made on the server (src/lib/admin/seo/list.ts) and only their types come here.

export type { SeoListPage, SeoListRow, SeoPanelSetup } from '@/lib/admin/seo/list';
export type { SeoEntityType } from '@/lib/seo/entityPaths';

export type Bi = { en: string; ar: string };

/** The three views of /admin/seo, one per in-page tab. */
export type SeoView = 'pages' | 'redirects' | 'site';

/** The type chips of the Pages tab, in their order, with the words they show. */
export const SEO_TYPE_CHIPS = [
  { value: 'page', label: 'Pages' },
  { value: 'service', label: 'Services' },
  { value: 'portfolio', label: 'Projects' },
  { value: 'blog_post', label: 'Posts' },
] as const;
