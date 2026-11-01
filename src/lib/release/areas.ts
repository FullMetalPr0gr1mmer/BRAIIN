import type { Capability } from '@/lib/authz/matrix';
import type { ReleaseArea, ReleaseEntityType } from '@schemas/release';

// What each release-managed entity type is, in the terms a publisher needs (Admin v2 R2,
// docs/admin-v2/releases.md §1.1): its area, the capabilities that make a change to it
// live, the one that removes it, and where it falls in the apply order. Pure data with
// type-only imports, so a React island may import it (R12's publish dialog decides "who
// can publish this" in the browser); src/lib/release/registry.ts binds each type to its
// server-side config and is held equal to app.release_entities (migration 0038) by
// tests/lib/releaseRegistry.spec.ts.

export interface ReleaseEntityMeta {
  area: ReleaseArea;
  /**
   * Every capability needed to stage or publish a change. A content type needs its write
   * capability AND `content.publish` (the first entry is always the write capability its
   * editor requires); identity, theme, SEO and redirects need their own capability only.
   */
  authorCaps: readonly Capability[];
  /** Needed in addition to remove a row or archive it; null = never removed by a release. */
  removeCap: Capability | null;
  /** The row's key: `tenant_id` for the per-tenant singletons. */
  key: 'id' | 'tenant_id';
  /** Creates and updates apply in ascending order; deletes in descending order. */
  applyOrder: number;
  /** Whether `status` is a content lifecycle (a redirect's `status` is an HTTP code). */
  hasStatus: boolean;
  /** The boolean column whose flip to true is a go-live. */
  publishFlag: 'visible' | null;
}

const content = (
  area: ReleaseArea,
  writeCap: Capability,
  applyOrder: number,
  hasStatus: boolean,
  publishFlag: 'visible' | null = null,
): ReleaseEntityMeta => ({
  area,
  authorCaps: [writeCap, 'content.publish'],
  removeCap: 'content.archiveDelete',
  key: 'id',
  applyOrder,
  hasStatus,
  publishFlag,
});

export const RELEASE_ENTITY_META: Readonly<Record<ReleaseEntityType, ReleaseEntityMeta>> = {
  category: content('blog', 'categories.manage', 10, false),
  sector: content('our_work', 'categories.manage', 10, false, 'visible'),
  client: content('our_work', 'portfolio.write', 10, false, 'visible'),
  team_member: content('collections', 'blog.write', 10, true),
  statistic: content('collections', 'services.write', 10, true),
  certification: content('collections', 'services.write', 10, true),
  discipline: content('services', 'services.write', 20, true),
  service: content('services', 'services.write', 30, true),
  portfolio: content('our_work', 'portfolio.write', 40, true),
  service_case: content('services', 'services.write', 50, true),
  testimonial: content('our_work', 'portfolio.write', 60, true),
  blog_post: content('blog', 'blog.write', 70, true),
  page: content('pages', 'pages.write', 80, true),
  page_section: content('pages', 'pages.write', 90, false, 'visible'),
  nav_item: content('navigation', 'nav.edit', 100, false, 'visible'),
  site_profile: {
    area: 'settings',
    authorCaps: ['settings.general'],
    removeCap: null,
    key: 'tenant_id',
    applyOrder: 110,
    hasStatus: false,
    publishFlag: null,
  },
  custom_theme: {
    area: 'appearance',
    authorCaps: ['theme.edit'],
    // The admin-only theme delete gate (0038): only an Admin removes a theme.
    removeCap: 'content.archiveDelete',
    key: 'id',
    applyOrder: 110,
    hasStatus: false,
    publishFlag: null,
  },
  entity_seo: {
    area: 'seo',
    authorCaps: ['seo.entityMeta'],
    removeCap: null,
    key: 'id',
    applyOrder: 120,
    hasStatus: false,
    publishFlag: null,
  },
  seo_defaults: {
    area: 'seo',
    authorCaps: ['seo.globalDefaults'],
    removeCap: null,
    key: 'tenant_id',
    applyOrder: 120,
    hasStatus: false,
    publishFlag: null,
  },
  redirect: {
    area: 'seo',
    authorCaps: ['redirects.manage'],
    // §5 gives SEO the whole module, removals included.
    removeCap: 'redirects.manage',
    key: 'id',
    applyOrder: 130,
    hasStatus: false,
    publishFlag: null,
  },
  // Page visibility (Admin v2 U14a, 0057): §5 "Maintenance / hidden pages / page visibility"
  // (P-2). After pages, whose ids it names; never removed by a release ("public" is a mode).
  page_visibility: {
    area: 'settings',
    authorCaps: ['maintenance.manage'],
    removeCap: null,
    key: 'id',
    applyOrder: 85,
    hasStatus: false,
    publishFlag: null,
  },
  // The FAQ (Admin v2 U7, 0098): Contact-page content (pages.write, P-2).
  faq_item: content('collections', 'pages.write', 10, true),
  // The forms config (Admin v2 E8): "Identity + footer + forms config" publish under
  // settings.general (P-2); a singleton, never removed by a release.
  form_settings: {
    area: 'settings',
    authorCaps: ['settings.general'],
    removeCap: null,
    key: 'tenant_id',
    applyOrder: 110,
    hasStatus: false,
    publishFlag: null,
  },
  // The site's appearance settings (Admin v2 E5): "Theme + header/intro appearance" publish
  // under theme.edit (P-2); a singleton, never removed by a release.
  site_appearance: {
    area: 'appearance',
    authorCaps: ['theme.edit'],
    removeCap: null,
    key: 'tenant_id',
    applyOrder: 110,
    hasStatus: false,
    publishFlag: null,
  },
};

/** The areas whose changes are content (write capability + `content.publish`). */
export const CONTENT_AREAS: readonly ReleaseArea[] = [
  'pages',
  'services',
  'our_work',
  'collections',
  'blog',
  'navigation',
];
