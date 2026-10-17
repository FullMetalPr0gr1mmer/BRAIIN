// The tables the public loaders read and the foreign keys between them, for the preview
// (Admin v2 R8): how the emulator resolves an embed, and what a pending delete does to the
// rows that point at the removed one. Each key cites the migration that declares it.
// tests/lib/previewLoaders.spec.ts fails when a loader reads a table or embeds a target
// this file does not know, so a slice that adds a public read cannot skip it.
//
// Pure data and lookups: no request state.

/** Every table a public loader reads, top-level or through an embed (21). */
export const PREVIEW_TABLES = [
  'blog_posts',
  'categories',
  'certifications',
  'clients',
  'disciplines',
  'entity_seo',
  'media_assets',
  'navigation',
  'page_sections',
  'pages',
  'portfolio',
  'portfolio_media',
  'portfolio_services',
  'sectors',
  'seo_defaults',
  'service_cases',
  'services',
  'site_profile',
  'statistics',
  'team_members',
  'testimonials',
] as const;
export type PreviewTable = (typeof PREVIEW_TABLES)[number];

export function isPreviewTable(table: string): table is PreviewTable {
  return (PREVIEW_TABLES as readonly string[]).includes(table);
}

/**
 * Each table's key, in the order the dataset pages by (offset paging needs a stable,
 * unique order). The singletons are keyed by their tenant (0009, 0019); a case study's
 * service links by the pair (0001's primary key).
 */
export const TABLE_KEYS: Readonly<Record<PreviewTable, readonly string[]>> = {
  blog_posts: ['id'],
  categories: ['id'],
  certifications: ['id'],
  clients: ['id'],
  disciplines: ['id'],
  entity_seo: ['id'],
  media_assets: ['id'],
  navigation: ['id'],
  page_sections: ['id'],
  pages: ['id'],
  portfolio: ['id'],
  portfolio_media: ['id'],
  portfolio_services: ['portfolio_id', 'service_id'],
  sectors: ['id'],
  seo_defaults: ['tenant_id'],
  service_cases: ['id'],
  services: ['id'],
  site_profile: ['tenant_id'],
  statistics: ['id'],
  team_members: ['id'],
  testimonials: ['id'],
};

export type OnDelete = 'cascade' | 'set null' | 'restrict';

export interface ForeignKey {
  /** The referencing table and column. */
  readonly table: PreviewTable;
  readonly column: string;
  /** The referenced table (always by its `id`). */
  readonly target: PreviewTable;
  readonly onDelete: OnDelete;
  /** Where it is declared. */
  readonly migration: string;
}

/**
 * Every foreign key between the preview tables. `restrict` keys change nothing in
 * preview: a pending delete the database would refuse at publish (R6 refuses it first) is
 * still shown removed, and what pointed at it embeds null.
 */
export const FOREIGN_KEYS: readonly ForeignKey[] = [
  {
    table: 'blog_posts',
    column: 'author_id',
    target: 'team_members',
    onDelete: 'set null',
    migration: '0001',
  },
  {
    table: 'blog_posts',
    column: 'category_id',
    target: 'categories',
    onDelete: 'set null',
    migration: '0001',
  },
  {
    table: 'portfolio_services',
    column: 'portfolio_id',
    target: 'portfolio',
    onDelete: 'cascade',
    migration: '0001',
  },
  {
    table: 'portfolio_services',
    column: 'service_id',
    target: 'services',
    onDelete: 'cascade',
    migration: '0001',
  },
  {
    table: 'page_sections',
    column: 'page_id',
    target: 'pages',
    onDelete: 'cascade',
    migration: '0001',
  },
  {
    table: 'navigation',
    column: 'parent_id',
    target: 'navigation',
    onDelete: 'cascade',
    migration: '0009',
  },
  {
    table: 'clients',
    column: 'logo_media_id',
    target: 'media_assets',
    onDelete: 'restrict',
    migration: '0021',
  },
  {
    table: 'testimonials',
    column: 'client_id',
    target: 'clients',
    onDelete: 'set null',
    migration: '0021',
  },
  {
    table: 'testimonials',
    column: 'portfolio_id',
    target: 'portfolio',
    onDelete: 'set null',
    migration: '0021',
  },
  {
    table: 'testimonials',
    column: 'avatar_media_id',
    target: 'media_assets',
    onDelete: 'restrict',
    migration: '0021',
  },
  {
    table: 'portfolio',
    column: 'sector_id',
    target: 'sectors',
    onDelete: 'set null',
    migration: '0022',
  },
  {
    table: 'portfolio',
    column: 'client_id',
    target: 'clients',
    onDelete: 'set null',
    migration: '0022',
  },
  {
    table: 'portfolio',
    column: 'poster_media_id',
    target: 'media_assets',
    onDelete: 'restrict',
    migration: '0022',
  },
  {
    table: 'portfolio',
    column: 'next_portfolio_id',
    target: 'portfolio',
    onDelete: 'set null',
    migration: '0022',
  },
  {
    table: 'portfolio_media',
    column: 'portfolio_id',
    target: 'portfolio',
    onDelete: 'cascade',
    migration: '0022',
  },
  {
    table: 'portfolio_media',
    column: 'media_id',
    target: 'media_assets',
    onDelete: 'restrict',
    migration: '0022',
  },
  {
    table: 'team_members',
    column: 'portrait_media_id',
    target: 'media_assets',
    onDelete: 'restrict',
    migration: '0023',
  },
  {
    table: 'disciplines',
    column: 'poster_media_id',
    target: 'media_assets',
    onDelete: 'restrict',
    migration: '0028',
  },
  {
    table: 'services',
    column: 'discipline_id',
    target: 'disciplines',
    onDelete: 'restrict',
    migration: '0028',
  },
  {
    table: 'services',
    column: 'poster_media_id',
    target: 'media_assets',
    onDelete: 'restrict',
    migration: '0028',
  },
  {
    table: 'service_cases',
    column: 'service_id',
    target: 'services',
    onDelete: 'cascade',
    migration: '0028',
  },
  {
    table: 'service_cases',
    column: 'portfolio_id',
    target: 'portfolio',
    onDelete: 'set null',
    migration: '0028',
  },
];

/** How an embed joins: to one row through a column, or to the rows that point back. */
export type EmbedRelation =
  | { readonly cardinality: 'one'; readonly column: string; readonly target: PreviewTable }
  | { readonly cardinality: 'many'; readonly target: PreviewTable; readonly childColumn: string };

/**
 * Resolves `target` in `table`'s select as PostgREST would, for the forms the loaders use:
 *   - a foreign-key column of `table` (`poster:poster_media_id(...)`): to one;
 *   - the name of the table one of `table`'s keys references (`author:team_members(...)`
 *     through blog_posts.author_id): to one, when exactly one key does;
 *   - the name of a table with exactly one key referencing `table`
 *     (`services:portfolio_services(...)` from portfolio): to many.
 * Null when it is none of these, or ambiguous (PostgREST answers PGRST200/PGRST201; here the
 * emulator refuses it). Many-to-many through a junction is not resolved.
 */
export function resolveEmbed(table: string, target: string): EmbedRelation | null {
  const byColumn = FOREIGN_KEYS.find((fk) => fk.table === table && fk.column === target);
  if (byColumn) return { cardinality: 'one', column: byColumn.column, target: byColumn.target };
  if (!isPreviewTable(target)) return null;
  const outgoing = FOREIGN_KEYS.filter((fk) => fk.table === table && fk.target === target);
  const incoming = FOREIGN_KEYS.filter((fk) => fk.table === target && fk.target === table);
  if (outgoing.length + incoming.length !== 1) return null;
  if (outgoing.length === 1) {
    return { cardinality: 'one', column: outgoing[0]!.column, target };
  }
  return { cardinality: 'many', target, childColumn: incoming[0]!.column };
}

/** The keys that point at `table`, with what a delete of the referenced row does. */
export function referencing(table: PreviewTable): readonly ForeignKey[] {
  return FOREIGN_KEYS.filter((fk) => fk.target === table);
}
