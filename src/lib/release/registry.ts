import type { Access, Capability } from '@/lib/authz/matrix';
import type { ResourceConfig } from '@/lib/admin/resource';
import type { SingletonConfig } from '@/lib/admin/singleton';
import { ENTITY_SEO } from '@/lib/admin/entitySeo';
import { PAGE_VISIBILITY } from '@/lib/admin/pageVisibility';
import { postResource } from '@/lib/admin/resources/blog';
import { categoryResource } from '@/lib/admin/resources/categories';
import { certificationResource } from '@/lib/admin/resources/certifications';
import { clientResource } from '@/lib/admin/resources/clients';
import { disciplineResource } from '@/lib/admin/resources/disciplines';
import { faqResource } from '@/lib/admin/resources/faq';
import { navigationResource } from '@/lib/admin/resources/navigation';
import { pageResource } from '@/lib/admin/resources/pages';
import { portfolioResource } from '@/lib/admin/resources/portfolio';
import { redirectResource } from '@/lib/admin/resources/redirects';
import { sectionResource } from '@/lib/admin/resources/sections';
import { sectorResource } from '@/lib/admin/resources/sectors';
import { serviceCaseResource } from '@/lib/admin/resources/serviceCases';
import { serviceResource } from '@/lib/admin/resources/services';
import { statisticResource } from '@/lib/admin/resources/statistics';
import { teamResource } from '@/lib/admin/resources/team';
import { testimonialResource } from '@/lib/admin/resources/testimonials';
import { themeResource } from '@/lib/admin/resources/themes';
import { seoDefaultsSingleton } from '@/lib/admin/singletons/seoDefaults';
import { siteProfileSingleton } from '@/lib/admin/singletons/siteProfile';
import { RELEASE_ENTITY_TYPES, type ReleaseArea, type ReleaseEntityType } from '@schemas/release';
import { RELEASE_ENTITY_META } from './areas';

// The release registry in TypeScript (Admin v2 R2): app.release_entities (migration
// 0038) row for row, each type bound to the config its editor already uses, so a pending
// change is parsed, mapped to columns and checked exactly as a save is.
// tests/lib/releaseRegistry.spec.ts reads every migration's registry rows and fails on a
// type, table, key, area, apply order, column or flag that differs: a migration that adds
// a registry row must add its entry here.
//
// SERVER ONLY: it imports the resource configs (the Tiptap renderer, server code). Islands
// import ./areas and ./caps instead. Nothing imports this module from a route until R3.

type Row = Record<string, unknown>;

/** A label in the admin's two languages (Arabic when the row has it). */
export interface ReleaseLabel {
  en: string;
  ar?: string;
}

export interface RegistryEntry {
  entityType: ReleaseEntityType;
  table: string;
  key: 'id' | 'tenant_id';
  area: ReleaseArea;
  kind: 'resource' | 'singleton' | 'entitySeo' | 'pageVisibility';
  /** kind 'resource'. */
  resource?: ResourceConfig;
  /** kind 'singleton'. */
  singleton?: SingletonConfig;
  /** kind 'entitySeo'. */
  entitySeo?: typeof ENTITY_SEO;
  /** kind 'pageVisibility' (Admin v2 U14a). */
  pageVisibility?: typeof PAGE_VISIBILITY;
  /** All required to stage or publish a change (with content.publish for content areas). */
  authorCaps: readonly Capability[];
  /** Required in addition for op 'delete' or a status → archived; null = never removable. */
  removeCap: Capability | null;
  /** Who may read the entity in the admin (any one, at one of `readAccess`). */
  readCaps: readonly Capability[];
  readAccess: readonly Access[];
  /** Payload key → the columns it can emit (the config's own `fields`). */
  fields: Readonly<Record<string, readonly string[]>>;
  /** The writable allowlist: equal to app.release_entities.columns. */
  columns: readonly string[];
  /** Self-references, set in a second pass after every row exists. */
  deferredColumns: readonly string[];
  /** Flags unique per scope (a partial unique index): cleared before they are set. */
  uniqueFlags: readonly string[];
  /** Columns that stay immediate: never in a patch (app.release_entities.exempt_columns). */
  immediateColumns: readonly string[];
  applyOrder: number;
  hasStatus: boolean;
  publishFlag: 'visible' | null;
  /** Payload keys a save writes outside `toRow` (portfolio: ['serviceIds', 'media']). */
  childKeys: readonly string[];
  /** Child key → the key `fromRow` returns it under (portfolio: serviceIds → service_ids). */
  childRowKeys: Readonly<Record<string, string>>;
  label(row: Row): ReleaseLabel;
  /**
   * This row's own cache tags (the vocabulary routes stamp). R7 unions the before and
   * after rows', adds sitemap/llms and collapses more than 30 to `tenant:default`.
   */
  entityTags(row: Row | null): string[];
  /** For a child whose page tag needs its parent's slug (page_section → page). R7 resolves it. */
  tagParent?: { entityType: 'page'; column: 'page_id' };
  /** Entity SEO is tagged as its target (`service:<slug>`…), which R7 resolves. */
  tagTarget?: true;
}

// ---- labels and tags ----------------------------------------------------------------------

/** A bilingual `{en, ar}` column or plain text → a label, or null when empty. */
function textOf(value: unknown): ReleaseLabel | null {
  if (typeof value === 'string') return value.trim() ? { en: value } : null;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as Row;
    const en = typeof v['en'] === 'string' ? v['en'].trim() : '';
    const ar = typeof v['ar'] === 'string' ? v['ar'].trim() : '';
    if (en && ar) return { en, ar };
    if (en || ar) return { en: en || ar };
  }
  return null;
}

/** The first column of the row that reads as text, else the fallback. */
const labelFrom =
  (columns: readonly string[], fallback: string) =>
  (row: Row): ReleaseLabel => {
    for (const column of columns) {
      const label = textOf(row[column]);
      if (label) return label;
    }
    return { en: fallback };
  };

const slugOf = (row: Row | null): string | null =>
  row && typeof row['slug'] === 'string' && row['slug'] ? row['slug'] : null;

/** Fixed tags, whatever the row. */
const tags =
  (...list: string[]) =>
  (): string[] => [...list];

/** `<entity>:<slug>` (when the row has a slug) plus fixed tags. */
const slugTags =
  (prefix: string, ...list: string[]) =>
  (row: Row | null): string[] => {
    const slug = slugOf(row);
    return slug ? [`${prefix}:${slug}`, ...list] : [...list];
  };

// ---- entries ------------------------------------------------------------------------------

/** Columns a content row never takes from a release (0038's allowlist leaves both out). */
const NEVER_STAGED = new Set(['published_at', 'scheduled_for']);

interface Extra {
  deferredColumns?: readonly string[];
  uniqueFlags?: readonly string[];
  /**
   * In the SQL allowlist although no payload key emits it: `page_sections.style`, which
   * SectionWriteSchema no longer accepts (nothing could apply it under the nonce CSP)
   * while the column stays, so a restore (R10) may still carry an old row's value.
   */
  restoreOnlyColumns?: readonly string[];
  label: (row: Row) => ReleaseLabel;
  entityTags: (row: Row | null) => string[];
  tagParent?: RegistryEntry['tagParent'];
}

/** The allowlist a config's `fields` implies (see Extra.restoreOnlyColumns). */
function columnsOf(
  fields: Readonly<Record<string, readonly string[]>>,
  immediate: readonly string[],
  restoreOnly: readonly string[],
): string[] {
  const skip = new Set([...NEVER_STAGED, ...immediate]);
  const out = new Set<string>();
  for (const columns of Object.values(fields)) {
    for (const column of columns) if (!skip.has(column)) out.add(column);
  }
  for (const column of restoreOnly) out.add(column);
  return [...out];
}

function fieldsOfConfig(
  config: { fields?: Readonly<Record<string, readonly string[]>> },
  type: string,
) {
  if (!config.fields) throw new Error(`release registry: ${type} declares no fields`);
  return config.fields;
}

function fromResource(
  entityType: ReleaseEntityType,
  resource: ResourceConfig,
  extra: Extra,
): RegistryEntry {
  const meta = RELEASE_ENTITY_META[entityType];
  const fields = fieldsOfConfig(resource, entityType);
  const childKeys = resource.childKeys ?? [];
  return {
    entityType,
    table: resource.table,
    key: meta.key,
    area: meta.area,
    kind: 'resource',
    resource,
    authorCaps: meta.authorCaps,
    removeCap: meta.removeCap,
    readCaps: resource.readCaps ?? [resource.writeCap],
    readAccess: resource.readAccess ?? ['full', 'view', 'meta'],
    fields,
    columns: columnsOf(fields, [], extra.restoreOnlyColumns ?? []),
    deferredColumns: extra.deferredColumns ?? [],
    uniqueFlags: extra.uniqueFlags ?? [],
    immediateColumns: [],
    applyOrder: meta.applyOrder,
    hasStatus: meta.hasStatus,
    publishFlag: meta.publishFlag,
    childKeys,
    childRowKeys: entityType === 'portfolio' ? { serviceIds: 'service_ids', media: 'media' } : {},
    label: extra.label,
    entityTags: extra.entityTags,
    ...(extra.tagParent ? { tagParent: extra.tagParent } : {}),
  };
}

function fromSingleton(
  entityType: ReleaseEntityType,
  singleton: SingletonConfig,
  extra: Extra,
): RegistryEntry {
  const meta = RELEASE_ENTITY_META[entityType];
  const fields = fieldsOfConfig(singleton, entityType);
  const immediate = singleton.immediateColumns ?? [];
  return {
    entityType,
    table: singleton.table,
    key: meta.key,
    area: meta.area,
    kind: 'singleton',
    singleton,
    authorCaps: meta.authorCaps,
    removeCap: meta.removeCap,
    readCaps: singleton.readCaps,
    readAccess: singleton.readAccess ?? ['full', 'view', 'meta'],
    fields,
    columns: columnsOf(fields, immediate, []),
    deferredColumns: [],
    uniqueFlags: [],
    immediateColumns: immediate,
    applyOrder: meta.applyOrder,
    hasStatus: meta.hasStatus,
    publishFlag: meta.publishFlag,
    childKeys: [],
    childRowKeys: {},
    label: extra.label,
    entityTags: extra.entityTags,
  };
}

function fromEntitySeo(extra: Extra): RegistryEntry {
  const meta = RELEASE_ENTITY_META.entity_seo;
  return {
    entityType: 'entity_seo',
    table: ENTITY_SEO.table,
    key: meta.key,
    area: meta.area,
    kind: 'entitySeo',
    entitySeo: ENTITY_SEO,
    authorCaps: meta.authorCaps,
    removeCap: meta.removeCap,
    // Content Creator holds `view` (the route's GET admits it).
    readCaps: [ENTITY_SEO.writeCap],
    readAccess: ['full', 'view'],
    fields: ENTITY_SEO.fields,
    columns: columnsOf(ENTITY_SEO.fields, [], []),
    deferredColumns: [],
    uniqueFlags: [],
    immediateColumns: [],
    applyOrder: meta.applyOrder,
    hasStatus: meta.hasStatus,
    publishFlag: meta.publishFlag,
    childKeys: [],
    childRowKeys: {},
    label: extra.label,
    entityTags: extra.entityTags,
    tagTarget: true,
  };
}

function fromPageVisibility(extra: Extra): RegistryEntry {
  const meta = RELEASE_ENTITY_META.page_visibility;
  return {
    entityType: 'page_visibility',
    table: PAGE_VISIBILITY.table,
    key: meta.key,
    area: meta.area,
    kind: 'pageVisibility',
    pageVisibility: PAGE_VISIBILITY,
    authorCaps: meta.authorCaps,
    removeCap: meta.removeCap,
    readCaps: PAGE_VISIBILITY.readCaps,
    readAccess: ['full'],
    fields: PAGE_VISIBILITY.fields,
    columns: columnsOf(
      PAGE_VISIBILITY.fields,
      PAGE_VISIBILITY.immediateColumns,
      PAGE_VISIBILITY.restoreOnlyColumns,
    ),
    deferredColumns: [],
    uniqueFlags: [],
    immediateColumns: PAGE_VISIBILITY.immediateColumns,
    applyOrder: meta.applyOrder,
    hasStatus: meta.hasStatus,
    publishFlag: meta.publishFlag,
    childKeys: [],
    childRowKeys: {},
    label: extra.label,
    entityTags: extra.entityTags,
    ...(extra.tagParent ? { tagParent: extra.tagParent } : {}),
  };
}

const named = (fallback: string) => labelFrom(['name', 'slug'], fallback);
const titled = (fallback: string) => labelFrom(['title', 'slug'], fallback);

export const RELEASE_REGISTRY: Readonly<Record<ReleaseEntityType, RegistryEntry>> = {
  category: fromResource('category', categoryResource, {
    label: named('Category'),
    entityTags: tags('blog:all'),
  }),
  sector: fromResource('sector', sectorResource, {
    label: named('Sector'),
    entityTags: tags('sectors:all'),
  }),
  client: fromResource('client', clientResource, {
    label: named('Client'),
    entityTags: tags('clients:all'),
  }),
  team_member: fromResource('team_member', teamResource, {
    label: named('Team member'),
    entityTags: tags('team:all'),
  }),
  statistic: fromResource('statistic', statisticResource, {
    label: labelFrom(['label', 'slug'], 'Statistic'),
    entityTags: tags('statistics:all'),
  }),
  certification: fromResource('certification', certificationResource, {
    label: named('Certification'),
    // A tag no route stamps yet: R7 adds it to the pages that render certifications.
    entityTags: tags('certifications:all'),
  }),
  discipline: fromResource('discipline', disciplineResource, {
    label: named('Discipline'),
    entityTags: tags('disciplines:all', 'services:all'),
  }),
  service: fromResource('service', serviceResource, {
    label: titled('Service'),
    entityTags: slugTags('service', 'services:all'),
  }),
  portfolio: fromResource('portfolio', portfolioResource, {
    deferredColumns: ['next_portfolio_id'],
    label: titled('Case study'),
    entityTags: slugTags('portfolio', 'portfolio:all'),
  }),
  service_case: fromResource('service_case', serviceCaseResource, {
    label: labelFrom(['title'], 'Case study block'),
    entityTags: tags('service_cases:all'),
  }),
  testimonial: fromResource('testimonial', testimonialResource, {
    label: labelFrom(['author_name', 'slug'], 'Testimonial'),
    entityTags: tags('testimonials:all'),
  }),
  blog_post: fromResource('blog_post', postResource, {
    label: titled('Post'),
    entityTags: slugTags('blog', 'blog:all'),
  }),
  page: fromResource('page', pageResource, {
    label: titled('Page'),
    entityTags: slugTags('page'),
  }),
  page_section: fromResource('page_section', sectionResource, {
    restoreOnlyColumns: ['style'],
    // Admin v2 E1: the name the page editor gave it (0115's `label`), else its type.
    label: (row) => ({
      en:
        typeof row['label'] === 'string' && row['label'].trim() !== ''
          ? `Section: ${row['label'].trim()}`
          : typeof row['type'] === 'string'
            ? `Section: ${row['type']}`
            : 'Section',
    }),
    // Its page's tag, which needs the page's slug: R7 reads it through tagParent.
    entityTags: tags(),
    tagParent: { entityType: 'page', column: 'page_id' },
  }),
  nav_item: fromResource('nav_item', navigationResource, {
    deferredColumns: ['parent_id'],
    uniqueFlags: ['is_key'],
    label: labelFrom(['label', 'href'], 'Menu link'),
    entityTags: tags('nav:all'),
  }),
  site_profile: fromSingleton('site_profile', siteProfileSingleton, {
    label: () => ({ en: 'Public identity' }),
    entityTags: tags('site:identity'),
  }),
  // Admin v2 E4: every Tier A page links the active theme (or would, once one is set), so a
  // theme's publish purges the ALWAYS tag every page carries for it, `site:chrome`.
  custom_theme: fromResource('custom_theme', themeResource, {
    label: named('Theme'),
    entityTags: tags('site:chrome'),
  }),
  entity_seo: fromEntitySeo({
    label: (row) => ({
      en: typeof row['entity_type'] === 'string' ? `SEO: ${row['entity_type']}` : 'SEO',
    }),
    // The target's tag (service:/portfolio:/page:/blog:<slug>): R7 resolves it.
    entityTags: tags(),
  }),
  seo_defaults: fromSingleton('seo_defaults', seoDefaultsSingleton, {
    label: () => ({ en: 'SEO defaults' }),
    entityTags: tags('tenant:default'),
  }),
  // No page tag: a redirect changes the edge map (KV `site:redirects`), rebuilt after the
  // release, not a cached page.
  redirect: fromResource('redirect', redirectResource, {
    label: (row) => ({
      en:
        typeof row['source_path'] === 'string'
          ? `${row['source_path']} → ${String(row['target_path'] ?? '')}`
          : 'Redirect',
    }),
    entityTags: tags(),
  }),
  // A page's visibility tags its page (R7 resolves the slug through tagParent) and the menus;
  // a template's, every page it renders. R7 adds the sitemap and llms.txt, and re-syncs the
  // KV snapshot after the apply and after a rollback (P-3).
  page_visibility: fromPageVisibility({
    label: (row) => ({
      en:
        row['template'] === 'service'
          ? 'Visibility: every service page'
          : row['template'] === 'case_study'
            ? 'Visibility: every case study page'
            : 'Page visibility',
    }),
    entityTags: (row) =>
      row?.['template'] === 'service'
        ? ['services:all', 'nav:all']
        : row?.['template'] === 'case_study'
          ? ['portfolio:all', 'nav:all']
          : ['nav:all'],
    tagParent: { entityType: 'page', column: 'page_id' },
  }),
  // The FAQ (Admin v2 U7, 0098): the Contact page's band and its FAQPage, both tagged
  // faq:all on the contact routes (CONTACT_CACHE_ENTITIES).
  faq_item: fromResource('faq_item', faqResource, {
    label: labelFrom(['question'], 'Question'),
    entityTags: tags('faq:all'),
  }),
};

/** The registry entry for one entity type. */
export function registryEntry(type: ReleaseEntityType): RegistryEntry {
  return RELEASE_REGISTRY[type];
}

const BY_TABLE: ReadonlyMap<string, RegistryEntry> = new Map(
  RELEASE_ENTITY_TYPES.map((type) => [RELEASE_REGISTRY[type].table, RELEASE_REGISTRY[type]]),
);

/** The registry entry for a table, or undefined when the table is not release-managed. */
export function registryByTable(table: string): RegistryEntry | undefined {
  return BY_TABLE.get(table);
}
