import type { ReleaseEntityType } from '@schemas/release';
import type { SaveTarget } from './entitySave';

// Which record an editor's History opens (Admin v2 R13; releases.md §7 "History drawer"). The
// editors know their save target (a kernel resource's slug), not the release registry, which
// is SERVER ONLY (it binds every type to its resource config); this is the slug → type half of
// it, written out so the field kit can name the record without the registry.
// tests/lib/historyTarget.spec.ts holds it equal to the registry: every release-managed
// resource is here under its own slug, and nothing else is.
//
// A record that is not release-managed (media, the Style-Finder, a theme's own list) has no
// history here; a new record has none yet.

export interface HistoryTarget {
  entityType: ReleaseEntityType;
  entityId: string;
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
