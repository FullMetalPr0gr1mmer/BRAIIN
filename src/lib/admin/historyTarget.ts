import type { ReleaseEntityType, SINGLETON_ENTITY_TYPES } from '@schemas/release';
import type { SaveTarget } from './entitySave';

// Which record an editor's History opens (Admin v2 R13; releases.md §7 "History drawer"). The
// editors know their save target (a kernel resource's slug), not the release registry, which
// is SERVER ONLY (it binds every type to its resource config); this is the slug → type half of
// it, written out so the field kit can name the record without the registry.
// tests/lib/versionsPage.spec.ts holds it equal to the registry: every release-managed
// resource is here under its own slug, and nothing else is.
//
// A record that is not release-managed (media, the Style-Finder, a theme's own list) has no
// history here; a new record has none yet.
//
// Admin v2 R14-prep: the two singletons (the identity on General, the SEO defaults on SEO ›
// Site wide) and a page's search settings (entity SEO, the shared SeoPanel) have History too.
// A singleton's history is keyed by the site, which the browser never names: its target's
// `entityId` is null and the server reads the session's tenant. Entity SEO is keyed by the
// row's own id, known once a row exists.

export interface HistoryTarget {
  entityType: ReleaseEntityType;
  /** The record's id; null for a singleton (the site's own: the server reads the tenant). */
  entityId: string | null;
}

/** The per-tenant singletons' history: no id, the server's tenant. */
export type SingletonEntityType = (typeof SINGLETON_ENTITY_TYPES)[number];
export function singletonHistory(entityType: SingletonEntityType): HistoryTarget {
  return { entityType, entityId: null };
}

/** A page's search settings (entity SEO), once its row exists. */
export function entitySeoHistory(rowId: string | null): HistoryTarget | null {
  return rowId ? { entityType: 'entity_seo', entityId: rowId } : null;
}

/** The history request's query (`GET /api/admin/history`): a singleton names no entity. */
export function historyQuery(target: HistoryTarget): string {
  const query = new URLSearchParams({ entityType: target.entityType });
  if (target.entityId !== null) query.set('entityId', target.entityId);
  return `/api/admin/history?${query.toString()}`;
}

/** The body of a one-version restore (`POST /api/admin/history/restore`). */
export function historyRestoreBody(
  target: HistoryTarget,
  seq: number,
): { entityType: ReleaseEntityType; entityId?: string; seq: number } {
  return target.entityId === null
    ? { entityType: target.entityType, seq }
    : { entityType: target.entityType, entityId: target.entityId, seq };
}

/** The kernel resources (src/lib/admin/resources, by slug) that the release registry manages. */
export const HISTORY_TYPE_OF_SLUG: Readonly<Record<string, ReleaseEntityType>> = {
  blog: 'blog_post',
  categories: 'category',
  certifications: 'certification',
  clients: 'client',
  disciplines: 'discipline',
  faq: 'faq_item',
  navigation: 'nav_item',
  pages: 'page',
  portfolio: 'portfolio',
  redirects: 'redirect',
  sections: 'page_section',
  sectors: 'sector',
  'service-cases': 'service_case',
  services: 'service',
  statistics: 'statistic',
  team: 'team_member',
  testimonials: 'testimonial',
  themes: 'custom_theme',
};

/** The record an editor on this target edits, when it has a history to open. */
export function historyTargetOf(target: SaveTarget, id: string | null): HistoryTarget | null {
  if (target.kind !== 'resource' || !id) return null;
  const entityType = HISTORY_TYPE_OF_SLUG[target.slug];
  return entityType ? { entityType, entityId: id } : null;
}
