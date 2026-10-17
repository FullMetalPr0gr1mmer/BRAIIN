import type { PreviewTable } from './relations';

// The anon RLS a visitor reads through, mirrored in TypeScript for the preview (Admin v2
// R8; releases.md §6.3 item 4, plan B7 item 11: a TS mirror held honest by R9's parity e2e
// on every Tier A route, not a database snapshot RPC). The preview reads every row the
// signed-in person may read (all statuses), lays the pending changes over them, and then
// keeps exactly the rows a visitor would see once those changes are live: a pending publish
// of a discipline shows its services, a pending hide of a page hides its sections, a
// pending delete hides the row (releases.md §8 edge case 24).
//
// Every rule below names the policy it mirrors and the latest migration that defines it.
// A policy's subquery runs under the reader's own RLS on the joined table, so a rule that
// looks at another table asks whether THAT row is visible, not only its status (a case of
// a service hidden by its discipline is hidden too, 0028). The tenant fence
// (`tenant_id = app.effective_tenant_id()`) is the dataset's: it keeps only the person's
// own tenant's rows and drops any other (src/lib/preview/dataset.ts).
//
// Drift costs preview fidelity only (staff already read every row). It is guarded three
// ways: supabase/tests/preview_dataset.test.sql pins the anon column grants, the column
// defaults CREATE_DEFAULTS copies and the set of policies that apply to an anon SELECT on
// each table, against literals tests/lib/previewMirror.spec.ts holds equal to the maps
// here; and R9's parity e2e compares preview and public HTML on seeded data.
//
// Page visibility (Admin v2 U14a, 0057) is NOT row security: anon has no privilege on
// public.page_visibility, no policy reads it, and a hidden page is answered at the edge
// (src/middleware.ts, from the KV snapshot) before any loader runs. So it adds no rule
// here, and its pending changes are "not previewed" at the data layer (dataset.ts). The
// password mode (U14b, 0061) IS row security: it adds page_sections_password_fence, a
// RESTRICTIVE SELECT TO anon hiding every section of a page whose visibility row is in
// password mode. When 0061 is on main, the pgTAP pin below fails until page_sections gains
// that rule here (read page_visibility rows through the person's client and hide the
// sections of a page in password mode).

type Row = Readonly<Record<string, unknown>>;

/**
 * Anon's column grants on the four tables granted by column (every other preview table is
 * granted to anon whole). The dataset reads these tables with exactly these columns, and
 * the emulator answers 42501 for any other, as PostgREST does for a visitor.
 */
export const ANON_COLUMNS: Readonly<Partial<Record<PreviewTable, readonly string[]>>> = {
  // 0021: never the consent record, the schedule or the placeholder flag.
  testimonials: [
    'id',
    'tenant_id',
    'slug',
    'quote',
    'author_name',
    'author_role',
    'client_id',
    'portfolio_id',
    'avatar_media_id',
    'placements',
    'status',
    'sort_order',
    'published_at',
    'updated_at',
  ],
  // 0024 (restated by 0045): what a public <img>/<Picture> needs, never display_name.
  media_assets: [
    'id',
    'tenant_id',
    'kind',
    'provider',
    'storage_path',
    'width',
    'height',
    'alt',
    'stream_uid',
    'mime_type',
    'updated_at',
  ],
  // 0028: never the schedule, version or actor columns.
  disciplines: [
    'id',
    'tenant_id',
    'slug',
    'name',
    'short',
    'blurb',
    'poster_media_id',
    'preview_video_path',
    'preview_start_s',
    'preview_end_s',
    'status',
    'sort_order',
    'published_at',
    'updated_at',
  ],
  // 0028: never is_placeholder, the schedule, version or the actors.
  service_cases: [
    'id',
    'tenant_id',
    'service_id',
    'portfolio_id',
    'title',
    'context',
    'problems',
    'results',
    'status',
    'published_at',
    'updated_at',
  ],
};

/**
 * Every policy that applies to an anon SELECT on each table (permissive or restrictive, FOR
 * SELECT or FOR ALL), by name. The rules below mirror the ones that can admit a visitor;
 * the `_write` policies (FOR ALL) and `media_read` admit only staff and add nothing for
 * anon, and `services_discipline_in_tenant` is `USING (true)`. Pinned against the database
 * by supabase/tests/preview_dataset.test.sql: a migration that adds, drops or renames one
 * fails there until this list and its rule follow.
 */
export const MIRRORED_POLICIES: Readonly<Record<PreviewTable, readonly string[]>> = {
  blog_posts: ['blog_read'],
  categories: ['categories_read', 'categories_write'],
  certifications: ['certifications_read', 'certifications_write'],
  clients: ['clients_read', 'clients_write'],
  disciplines: ['disciplines_read', 'disciplines_write'],
  entity_seo: ['entity_seo_published_only', 'entity_seo_read', 'entity_seo_write'],
  media_assets: ['media_assets_public_read', 'media_read', 'media_write'],
  navigation: ['navigation_read', 'navigation_visible_only', 'navigation_write'],
  page_sections: ['page_sections_published_only', 'page_sections_read', 'page_sections_write'],
  pages: ['pages_read', 'pages_write'],
  portfolio: ['portfolio_read', 'portfolio_write'],
  portfolio_media: ['portfolio_media_read', 'portfolio_media_write'],
  portfolio_services: [
    'portfolio_services_published_only',
    'portfolio_services_read',
    'portfolio_services_write',
  ],
  sectors: ['sectors_read', 'sectors_write'],
  seo_defaults: ['seo_defaults_read', 'seo_defaults_write'],
  service_cases: ['service_cases_published_parent', 'service_cases_read', 'service_cases_write'],
  services: ['services_discipline_in_tenant', 'services_discipline_published', 'services_read'],
  site_profile: ['site_profile_read'],
  statistics: ['statistics_read', 'statistics_write'],
  team_members: ['team_members_read', 'team_members_write'],
  testimonials: ['testimonials_read', 'testimonials_write'],
};

/** The providers 0045's media_assets_public_read admits (an `external` URL never). */
export const HOSTED_PROVIDERS: ReadonlySet<string> = new Set([
  'static',
  'cf_images',
  'stream',
  'storage',
]);

/** entity_seo.entity_type → the parent table 0011's entity_seo_published_only checks. */
const SEO_PARENTS: Readonly<Record<string, PreviewTable>> = {
  service: 'services',
  blog_post: 'blog_posts',
  portfolio: 'portfolio',
  page: 'pages',
};

/**
 * The tables a table's rule reads, directly (the dataset loads their closure before it
 * answers a query, so the rule never asks for a table it has not read).
 */
export const VISIBILITY_DEPS: Readonly<Record<PreviewTable, readonly PreviewTable[]>> = {
  blog_posts: [],
  categories: [],
  certifications: [],
  clients: [],
  disciplines: [],
  entity_seo: ['services', 'blog_posts', 'portfolio', 'pages'],
  media_assets: [
    'portfolio',
    'portfolio_media',
    'clients',
    'testimonials',
    'team_members',
    'page_sections',
    'disciplines',
    'services',
  ],
  navigation: [],
  page_sections: ['pages'],
  pages: [],
  portfolio: [],
  portfolio_media: ['portfolio'],
  portfolio_services: ['portfolio'],
  sectors: [],
  seo_defaults: [],
  service_cases: ['services'],
  services: ['disciplines'],
  site_profile: [],
  statistics: [],
  team_members: [],
  testimonials: [],
};

/** A table and every table its rule reaches, transitively. */
export function visibilityClosure(tables: Iterable<PreviewTable>): Set<PreviewTable> {
  const out = new Set<PreviewTable>();
  const visit = (table: PreviewTable): void => {
    if (out.has(table)) return;
    out.add(table);
    for (const dep of VISIBILITY_DEPS[table]) visit(dep);
  };
  for (const table of tables) visit(table);
  return out;
}

/** What the mirror reads: the overlaid rows of the person's tenant. */
export interface MirrorData {
  rows(table: PreviewTable): readonly Row[];
  /** The row whose `id` is `id`, or undefined. */
  byId(table: PreviewTable, id: unknown): Row | undefined;
}

export interface Mirror {
  /** Whether a visitor would read this row once the pending changes are live. */
  isVisible(table: PreviewTable, row: Row): boolean;
}

const published = (row: Row): boolean => row['status'] === 'published';
const flagged = (row: Row): boolean => row['visible'] === true;

/**
 * Every id 0024/0045's `lax $.**.mediaId ? (@ == $id)` finds in a section's content: the
 * value of a `mediaId` key at any depth, under objects and arrays, when it is a string or
 * an array (of arrays) holding strings, as lax mode unwraps arrays. A number never matches
 * the text id. (Checked against PostgreSQL's jsonpath: tests/lib/previewVisibility.spec.ts.)
 */
export function mediaIdsInContent(content: unknown): Set<string> {
  const out = new Set<string>();
  const strings = (value: unknown): void => {
    if (typeof value === 'string') out.add(value);
    else if (Array.isArray(value)) for (const item of value) strings(item);
  };
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
    } else if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'mediaId') strings(value);
        walk(value);
      }
    }
  };
  walk(content);
  return out;
}

/** The mirror for one request's dataset. Memoised per row; the media set is built once. */
export function createMirror(data: MirrorData): Mirror {
  const memo = new WeakMap<Row, boolean>();
  let mediaRefs: Set<string> | null = null;

  const visibleById = (table: PreviewTable, id: unknown): boolean => {
    if (id === null || id === undefined) return false;
    const row = data.byId(table, id);
    return row !== undefined && isVisible(table, row);
  };

  /** 0045 media_assets_public_read: the eight branches, each under anon's RLS. */
  const referencedMedia = (): Set<string> => {
    if (mediaRefs) return mediaRefs;
    const refs = new Set<string>();
    const add = (value: unknown): void => {
      if (typeof value === 'string') refs.add(value);
    };
    const each = (table: PreviewTable, column: string): void => {
      for (const row of data.rows(table)) if (isVisible(table, row)) add(row[column]);
    };
    // 1. a published project's poster
    each('portfolio', 'poster_media_id');
    // 2. a case-study frame of a published project (portfolio_media joined to portfolio)
    for (const row of data.rows('portfolio_media')) {
      if (isVisible('portfolio_media', row) && visibleById('portfolio', row['portfolio_id'])) {
        add(row['media_id']);
      }
    }
    // 3. a visible client's logo
    each('clients', 'logo_media_id');
    // 4. a published testimonial's avatar
    each('testimonials', 'avatar_media_id');
    // 5. a published team member's portrait
    each('team_members', 'portrait_media_id');
    // 6. a `mediaId` anywhere in a visible section of a published page
    for (const row of data.rows('page_sections')) {
      if (isVisible('page_sections', row) && visibleById('pages', row['page_id'])) {
        for (const id of mediaIdsInContent(row['content'])) refs.add(id);
      }
    }
    // 7. a published discipline's poster
    each('disciplines', 'poster_media_id');
    // 8. a published service's poster (under services' own RLS: its discipline's rule too)
    each('services', 'poster_media_id');
    mediaRefs = refs;
    return refs;
  };

  function rule(table: PreviewTable, row: Row): boolean {
    switch (table) {
      // 0001 services_read (published) AND 0028 services_discipline_published (RESTRICTIVE:
      // no discipline, or a published one).
      case 'services':
        return (
          published(row) &&
          (row['discipline_id'] === null ||
            row['discipline_id'] === undefined ||
            visibleById('disciplines', row['discipline_id']))
        );
      // 0028 service_cases_read (published) AND service_cases_published_parent
      // (RESTRICTIVE: its service published, under services' RLS).
      case 'service_cases':
        return published(row) && visibleById('services', row['service_id']);
      // 0028 disciplines_read; 0001 portfolio_read, blog_read, pages_read,
      // team_members_read; 0005 certifications_read, statistics_read; 0021
      // testimonials_read: published.
      case 'disciplines':
      case 'portfolio':
      case 'blog_posts':
      case 'pages':
      case 'team_members':
      case 'statistics':
      case 'certifications':
      case 'testimonials':
        return published(row);
      // 0001 portfolio_services_read (tenant) AND 0022 portfolio_services_published_only
      // (RESTRICTIVE: its project published).
      case 'portfolio_services':
        return visibleById('portfolio', row['portfolio_id']);
      // 0022 portfolio_media_read: its project published.
      case 'portfolio_media':
        return visibleById('portfolio', row['portfolio_id']);
      // 0001 page_sections_read (tenant) AND 0011 page_sections_published_only
      // (RESTRICTIVE: visible, and its page published). 0016 grants anon SELECT.
      case 'page_sections':
        return flagged(row) && visibleById('pages', row['page_id']);
      // 0009 navigation_read (tenant) AND 0011 navigation_visible_only (RESTRICTIVE).
      case 'navigation':
        return flagged(row);
      // 0021 sectors_read, clients_read: visible.
      case 'sectors':
      case 'clients':
        return flagged(row);
      // 0001 categories_read, 0019 site_profile_read, 0009 seo_defaults_read: the tenant
      // fence only.
      case 'categories':
      case 'site_profile':
      case 'seo_defaults':
        return true;
      // 0009 entity_seo_read (tenant) AND 0011 entity_seo_published_only (RESTRICTIVE: its
      // parent published, under the parent's RLS; an orphan or another entity type never).
      case 'entity_seo': {
        const parent = SEO_PARENTS[String(row['entity_type'])];
        return parent !== undefined && visibleById(parent, row['entity_id']);
      }
      // 0045 media_assets_public_read (restating 0028/0024): a hosted provider, referenced
      // by one of eight branches of visible content.
      case 'media_assets':
        return (
          typeof row['provider'] === 'string' &&
          HOSTED_PROVIDERS.has(row['provider']) &&
          typeof row['id'] === 'string' &&
          referencedMedia().has(row['id'])
        );
    }
  }

  function isVisible(table: PreviewTable, row: Row): boolean {
    const known = memo.get(row);
    if (known !== undefined) return known;
    const visible = rule(table, row);
    memo.set(row, visible);
    return visible;
  }

  return { isVisible };
}
