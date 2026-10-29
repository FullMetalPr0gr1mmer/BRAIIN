import type { DatasetTable, PreviewTable } from './relations';

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
// password mode (U14b, 0061) IS row security: page_sections_password_fence, a RESTRICTIVE
// SELECT TO anon and authenticated that staff pass, hides every section of a page whose
// visibility row is in password mode. The dataset reads page_visibility through the
// person's own client (every CMS role reads it, 0057) for that rule alone; no loader
// reads it and the emulator refuses it (a mirror-only table, relations.ts).

type Row = Readonly<Record<string, unknown>>;

/**
 * Anon's column grants on the seven tables granted by column (every other preview table is
 * granted to anon whole). The dataset reads these tables with exactly these columns, and
 * the emulator answers 42501 for any other, as PostgREST does for a visitor.
 */
export const ANON_COLUMNS: Readonly<Partial<Record<DatasetTable, readonly string[]>>> = {
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
  // 0098 (Admin v2 U7): never the version, the schedule, the publish date or the actors.
  faq_items: ['id', 'tenant_id', 'question', 'answer', 'status', 'sort_order'],
  // Admin v2 E8: the forms config's copy and its consent revision; never the version, the
  // stamps or the actors.
  form_settings: ['tenant_id', 'inquiry', 'application', 'consent_revision'],
  // 0105 (Admin v2 U11): the Search Console code the home page's head carries, and the
  // tenant; U15's migration: the GA4 measurement id, which a page that loads GA4 carries; never the
  // Calendly link or the legacy jsonb. (A preview never loads GA4: its branch of the middleware
  // returns before the GA4 read, and its layout renders no loader.)
  site_integrations: ['tenant_id', 'search_console_token', 'ga4_measurement_id'],
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
 * SELECT or FOR ALL), by name, with its kind and the md5 of its USING expression as
 * PostgreSQL prints it (pg_policies.qual). The rules below mirror the ones that can admit a
 * visitor; the `_write` policies (FOR ALL) and `media_read` admit only staff and add
 * nothing for anon, and `services_discipline_in_tenant` is `USING (true)`. Pinned against the
 * database by supabase/tests/preview_dataset.test.sql: a migration that adds, drops,
 * renames or rewrites one (the same name with another USING) fails there until this map
 * and its rule follow. Regenerate a changed entry from that assertion's output.
 */
export const MIRRORED_POLICIES: Readonly<
  Record<PreviewTable, Readonly<Record<string, `${'PERMISSIVE' | 'RESTRICTIVE'}:${string}`>>>
> = {
  blog_posts: {
    blog_read: 'PERMISSIVE:a3adeda401046be963dd172ac14b795c',
  },
  categories: {
    categories_read: 'PERMISSIVE:b6eed1472f5bbc22900b86ccd832dc54',
    categories_write: 'PERMISSIVE:e9df5a2a577f93c55a35e5f7bc235060',
  },
  certifications: {
    certifications_read: 'PERMISSIVE:a3adeda401046be963dd172ac14b795c',
    certifications_write: 'PERMISSIVE:e9df5a2a577f93c55a35e5f7bc235060',
  },
  clients: {
    clients_read: 'PERMISSIVE:db9934fa0ab3f173e346a67310b57bac',
    clients_write: 'PERMISSIVE:e9df5a2a577f93c55a35e5f7bc235060',
  },
  disciplines: {
    disciplines_read: 'PERMISSIVE:a3adeda401046be963dd172ac14b795c',
    disciplines_write: 'PERMISSIVE:e9df5a2a577f93c55a35e5f7bc235060',
  },
  // Admin v2 E8: the anon read, the tenant fence alone; the non-staff block is TO
  // authenticated, so it never applies to a visitor.
  form_settings: {
    form_settings_read: 'PERMISSIVE:b6eed1472f5bbc22900b86ccd832dc54',
  },
  faq_items: {
    faq_items_read: 'PERMISSIVE:a3adeda401046be963dd172ac14b795c',
    faq_items_write: 'PERMISSIVE:e9df5a2a577f93c55a35e5f7bc235060',
  },
  entity_seo: {
    entity_seo_published_only: 'RESTRICTIVE:df5c9a7d7588fed51b9e8704523bf0a3',
    entity_seo_read: 'PERMISSIVE:b6eed1472f5bbc22900b86ccd832dc54',
    entity_seo_write: 'PERMISSIVE:763c5ebb7d12ee38b8e17d30ad1570df',
  },
  media_assets: {
    media_assets_public_read: 'PERMISSIVE:f7fb1e5779de752edd5116394a0286de',
    media_read: 'PERMISSIVE:392446073406bce5902ebbac287245a1',
    media_write: 'PERMISSIVE:4f9223ffe3d088ba7a0a4098c7d190d6',
  },
  navigation: {
    navigation_read: 'PERMISSIVE:b6eed1472f5bbc22900b86ccd832dc54',
    navigation_visible_only: 'RESTRICTIVE:d3e6a42adad1d6a81062627de227ba33',
    navigation_write: 'PERMISSIVE:e9df5a2a577f93c55a35e5f7bc235060',
  },
  page_sections: {
    page_sections_password_fence: 'RESTRICTIVE:288466d0b0045b81ef63d2e215c90e8e',
    page_sections_published_only: 'RESTRICTIVE:1f97d3d1084c993ca178204580b8d11d',
    page_sections_read: 'PERMISSIVE:b6eed1472f5bbc22900b86ccd832dc54',
    page_sections_write: 'PERMISSIVE:e9df5a2a577f93c55a35e5f7bc235060',
  },
  pages: {
    pages_read: 'PERMISSIVE:a3adeda401046be963dd172ac14b795c',
    pages_write: 'PERMISSIVE:e9df5a2a577f93c55a35e5f7bc235060',
  },
  portfolio: {
    portfolio_read: 'PERMISSIVE:a3adeda401046be963dd172ac14b795c',
    portfolio_write: 'PERMISSIVE:e9df5a2a577f93c55a35e5f7bc235060',
  },
  portfolio_media: {
    portfolio_media_read: 'PERMISSIVE:89df8ca10e4d24f57e626287d4263bdb',
    portfolio_media_write: 'PERMISSIVE:e9df5a2a577f93c55a35e5f7bc235060',
  },
  portfolio_services: {
    portfolio_services_published_only: 'RESTRICTIVE:ebe8eb7b2d30d7fa86ce01cf9d110773',
    portfolio_services_read: 'PERMISSIVE:b6eed1472f5bbc22900b86ccd832dc54',
    portfolio_services_write: 'PERMISSIVE:e9df5a2a577f93c55a35e5f7bc235060',
  },
  sectors: {
    sectors_read: 'PERMISSIVE:db9934fa0ab3f173e346a67310b57bac',
    sectors_write: 'PERMISSIVE:e9df5a2a577f93c55a35e5f7bc235060',
  },
  seo_defaults: {
    seo_defaults_read: 'PERMISSIVE:b6eed1472f5bbc22900b86ccd832dc54',
    seo_defaults_write: 'PERMISSIVE:763c5ebb7d12ee38b8e17d30ad1570df',
  },
  service_cases: {
    service_cases_published_parent: 'RESTRICTIVE:5ec4bd1be2ede2fd328e9818b89a640d',
    service_cases_read: 'PERMISSIVE:a3adeda401046be963dd172ac14b795c',
    service_cases_write: 'PERMISSIVE:e9df5a2a577f93c55a35e5f7bc235060',
  },
  services: {
    services_discipline_in_tenant: 'RESTRICTIVE:b326b5062b2f0e69046810717534cb09',
    services_discipline_published: 'RESTRICTIVE:c37eff0d6d10d79117aab9034276c0fa',
    services_read: 'PERMISSIVE:a3adeda401046be963dd172ac14b795c',
  },
  // 0105 (U11): the anon read, the tenant fence alone; the staff policies are TO
  // authenticated, so none applies to a visitor.
  site_integrations: {
    site_integrations_public_read: 'PERMISSIVE:b6eed1472f5bbc22900b86ccd832dc54',
  },
  site_profile: {
    site_profile_read: 'PERMISSIVE:b6eed1472f5bbc22900b86ccd832dc54',
  },
  statistics: {
    statistics_read: 'PERMISSIVE:a3adeda401046be963dd172ac14b795c',
    statistics_write: 'PERMISSIVE:e9df5a2a577f93c55a35e5f7bc235060',
  },
  team_members: {
    team_members_read: 'PERMISSIVE:a3adeda401046be963dd172ac14b795c',
    team_members_write: 'PERMISSIVE:e9df5a2a577f93c55a35e5f7bc235060',
  },
  testimonials: {
    testimonials_read: 'PERMISSIVE:a3adeda401046be963dd172ac14b795c',
    testimonials_write: 'PERMISSIVE:e9df5a2a577f93c55a35e5f7bc235060',
  },
};

/** The providers 0045's media_assets_public_read admits (an `external` URL never). */
export const HOSTED_PROVIDERS: readonly string[] = ['static', 'cf_images', 'stream', 'storage'];

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
export const VISIBILITY_DEPS: Readonly<Record<DatasetTable, readonly DatasetTable[]>> = {
  blog_posts: [],
  categories: [],
  certifications: [],
  clients: [],
  disciplines: [],
  entity_seo: ['services', 'blog_posts', 'portfolio', 'pages'],
  faq_items: [],
  form_settings: [],
  media_assets: [
    'portfolio',
    'portfolio_media',
    'clients',
    'testimonials',
    'team_members',
    'page_sections',
    'disciplines',
    'services',
    'entity_seo',
    'seo_defaults',
    'site_profile',
  ],
  navigation: [],
  page_sections: ['pages', 'page_visibility'],
  page_visibility: [],
  pages: [],
  portfolio: [],
  portfolio_media: ['portfolio'],
  portfolio_services: ['portfolio'],
  sectors: [],
  seo_defaults: [],
  service_cases: ['services'],
  services: ['disciplines'],
  site_integrations: [],
  site_profile: [],
  statistics: [],
  team_members: [],
  testimonials: [],
};

/** A table and every table its rule reaches, transitively. */
export function visibilityClosure(tables: Iterable<DatasetTable>): Set<DatasetTable> {
  const out = new Set<DatasetTable>();
  const visit = (table: DatasetTable): void => {
    if (out.has(table)) return;
    out.add(table);
    for (const dep of VISIBILITY_DEPS[table]) visit(dep);
  };
  for (const table of tables) visit(table);
  return out;
}

/** What the mirror reads: the overlaid rows of the person's tenant. */
export interface MirrorData {
  rows(table: DatasetTable): readonly Row[];
  /** The row whose `id` is `id`, or undefined. */
  byId(table: DatasetTable, id: unknown): Row | undefined;
}

export interface Mirror {
  /** Whether a visitor would read this row once the pending changes are live. */
  isVisible(table: DatasetTable, row: Row): boolean;
}

const published = (row: Row): boolean => row['status'] === 'published';
const flagged = (row: Row): boolean => row['visible'] === true;

/**
 * Every id 0024/0045's `lax $.**.mediaId ? (@ == $id)` finds in a section's content: the
 * value of a `mediaId` key at any depth, under objects and arrays, when it is a string, an
 * array of strings or an array of arrays of strings: lax mode unwraps two array levels there
 * and no more (a string three arrays down does not match). A number never matches the text
 * id. (Checked case by case against PostgreSQL 18's jsonpath:
 * tests/lib/previewVisibility.spec.ts.)
 */
export function mediaIdsInContent(content: unknown): Set<string> {
  const out = new Set<string>();
  const strings = (value: unknown, arrays = 0): void => {
    if (typeof value === 'string') out.add(value);
    else if (Array.isArray(value) && arrays < 2) {
      for (const item of value) strings(item, arrays + 1);
    }
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

  const visibleById = (table: DatasetTable, id: unknown): boolean => {
    if (id === null || id === undefined) return false;
    const row = data.byId(table, id);
    return row !== undefined && isVisible(table, row);
  };

  let locked: Set<string> | null = null;
  /** 0061 app.page_is_password_locked: the pages whose visibility row is in password mode. */
  const passwordLocked = (): Set<string> => {
    if (locked) return locked;
    const pages = new Set<string>();
    for (const v of data.rows('page_visibility')) {
      if (v['mode'] === 'password' && typeof v['page_id'] === 'string') pages.add(v['page_id']);
    }
    locked = pages;
    return pages;
  };

  /**
   * 0102 media_assets_public_read: 0045's eight branches, 0073's two and 0102's icons, each
   * under anon's RLS.
   */
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
    // 6. a `mediaId` anywhere in a visible section of a published page; the subquery runs
    //    under anon's RLS on page_sections, so 0061's password fence applies here too
    for (const row of data.rows('page_sections')) {
      if (isVisible('page_sections', row) && visibleById('pages', row['page_id'])) {
        for (const id of mediaIdsInContent(row['content'])) refs.add(id);
      }
    }
    // 7. a published discipline's poster
    each('disciplines', 'poster_media_id');
    // 8. a published service's poster (under services' own RLS: its discipline's rule too)
    each('services', 'poster_media_id');
    // 9. (0073) a share image an SEO row names, under entity_seo's own RLS: its parent
    //    published (0011 entity_seo_published_only)
    each('entity_seo', 'og_media_id');
    // 10. (0073) the tenant's default share image
    each('seo_defaults', 'default_og_media_id');
    // 11. (0102) the site's favicon and app icon, under site_profile's own RLS (the tenant)
    each('site_profile', 'favicon_media_id');
    each('site_profile', 'app_icon_media_id');
    mediaRefs = refs;
    return refs;
  };

  function rule(table: DatasetTable, row: Row): boolean {
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
      // testimonials_read; 0098 faq_items_read: published.
      case 'faq_items':
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
      // (RESTRICTIVE: visible, and its page published) AND 0061 page_sections_password_fence
      // (RESTRICTIVE, TO anon and authenticated, staff pass: not a page whose
      // page_visibility row is in password mode, app.page_is_password_locked). 0016 grants
      // anon SELECT. The fence reads the LIVE page_visibility rows: a pending visibility
      // change is not previewed (dataset.ts).
      case 'page_sections':
        return (
          flagged(row) &&
          visibleById('pages', row['page_id']) &&
          !passwordLocked().has(String(row['page_id']))
        );
      // 0057: anon holds no privilege on page_visibility and no policy admits it; the
      // dataset reads it (staff do) only for the fence above.
      case 'page_visibility':
        return false;
      // 0009 navigation_read (tenant) AND 0011 navigation_visible_only (RESTRICTIVE).
      case 'navigation':
        return flagged(row);
      // 0021 sectors_read, clients_read: visible.
      case 'sectors':
      case 'clients':
        return flagged(row);
      // 0001 categories_read, 0019 site_profile_read, 0009 seo_defaults_read, 0105
      // site_integrations_public_read (U11; anon's two columns), E8 form_settings_read (anon's
      // four columns): the tenant fence only.
      case 'categories':
      case 'site_profile':
      case 'seo_defaults':
      case 'site_integrations':
      case 'form_settings':
        return true;
      // 0009 entity_seo_read (tenant) AND 0011 entity_seo_published_only (RESTRICTIVE: its
      // parent published, under the parent's RLS; an orphan or another entity type never).
      case 'entity_seo': {
        const parent = SEO_PARENTS[String(row['entity_type'])];
        return parent !== undefined && visibleById(parent, row['entity_id']);
      }
      // 0102 media_assets_public_read (restating 0073/0045/0028/0024): a hosted provider,
      // referenced by one of eleven branches of visible content.
      case 'media_assets':
        return (
          typeof row['provider'] === 'string' &&
          HOSTED_PROVIDERS.includes(row['provider']) &&
          typeof row['id'] === 'string' &&
          referencedMedia().has(row['id'])
        );
    }
  }

  function isVisible(table: DatasetTable, row: Row): boolean {
    const known = memo.get(row);
    if (known !== undefined) return known;
    const visible = rule(table, row);
    memo.set(row, visible);
    return visible;
  }

  return { isVisible };
}
