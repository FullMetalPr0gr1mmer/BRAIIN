import type { ReleaseEntityType } from '@schemas/release';

// The columns of each release-managed type that name another row (Admin v2 R6). A foreign key
// accepts another tenant's id, and the apply writes these columns through the registry with no
// check of its own (R4's open item "links into another tenant", review 9; R5's decision D11
// leaves the fence to this Worker check): a publish holds every link it writes to a row of the
// publisher's own tenant, as the state the release leaves (a pending new item in the same
// release counts; one left out is a dependency to tick). The case-study link sets
// (`portfolio_services`, `portfolio_media`) are fenced in the database by
// `app.apply_portfolio_children` (0051) and are not listed here.
//
// `removed`: what removing the row named does to this one (the foreign key's ON DELETE): a
// change to a row whose parent the same release removes is refused ("Section X is changed but
// its page is being removed", releases.md §8 edge case 3), as is a link the release would
// leave dangling (restrict) or quietly clear (set null).
// tests/lib/releaseLinks.spec.ts holds this list equal to the foreign keys the migrations
// declare on the allowlisted columns.

export interface LinkSpec {
  column: string;
  /** The table the column names a row of. */
  table: string;
  /** The payload key that writes the column (where an error is shown). */
  field: string;
  removed: 'cascade' | 'restrict' | 'set null';
  /**
   * Read through the service client (existence in the tenant only): staff read no profile but
   * their own (`profiles_self_select`), so a team member's account link cannot be checked as
   * the publisher.
   */
  service?: true;
}

const link = (
  column: string,
  table: string,
  field: string,
  removed: LinkSpec['removed'],
): LinkSpec => ({ column, table, field, removed });

const media = (column: string, field: string): LinkSpec =>
  link(column, 'media_assets', field, 'restrict');

export const RELEASE_LINKS: Readonly<Partial<Record<ReleaseEntityType, readonly LinkSpec[]>>> = {
  client: [media('logo_media_id', 'logoMediaId')],
  team_member: [
    { ...link('profile_user_id', 'profiles', 'profileUserId', 'set null'), service: true },
    media('portrait_media_id', 'portraitMediaId'),
  ],
  discipline: [media('poster_media_id', 'posterMediaId')],
  service: [
    link('discipline_id', 'disciplines', 'disciplineId', 'restrict'),
    media('poster_media_id', 'posterMediaId'),
  ],
  portfolio: [
    link('sector_id', 'sectors', 'sectorId', 'set null'),
    link('client_id', 'clients', 'clientId', 'set null'),
    media('poster_media_id', 'posterMediaId'),
    link('next_portfolio_id', 'portfolio', 'nextPortfolioId', 'set null'),
  ],
  service_case: [
    link('service_id', 'services', 'serviceId', 'cascade'),
    link('portfolio_id', 'portfolio', 'portfolioId', 'set null'),
  ],
  testimonial: [
    link('client_id', 'clients', 'clientId', 'set null'),
    link('portfolio_id', 'portfolio', 'portfolioId', 'set null'),
    media('avatar_media_id', 'avatarMediaId'),
  ],
  blog_post: [
    link('author_id', 'team_members', 'authorId', 'set null'),
    link('category_id', 'categories', 'categoryId', 'set null'),
  ],
  page_section: [link('page_id', 'pages', 'pageId', 'cascade')],
  nav_item: [link('parent_id', 'navigation', 'parentId', 'cascade')],
  page_visibility: [
    link('page_id', 'pages', 'target', 'cascade'),
    link('redirect_page_id', 'pages', 'redirectPageId', 'set null'),
  ],
  // The share images (U10, 0073); entity SEO's target is added by the rules (SEO_TARGET_TABLES).
  entity_seo: [media('og_media_id', 'ogMediaId')],
  seo_defaults: [media('default_og_media_id', 'defaultOgMediaId')],
  // The site's icons (U9, 0075): composite keys to the tenant's own media, RESTRICT.
  site_profile: [
    media('favicon_media_id', 'faviconMediaId'),
    media('app_icon_media_id', 'appIconMediaId'),
  ],
};

/** The table an entity-SEO row's target lives in (its `entity_type` CHECK, 0009). */
export const SEO_TARGET_TABLES: Readonly<Record<string, string>> = {
  service: 'services',
  blog_post: 'blog_posts',
  portfolio: 'portfolio',
  page: 'pages',
};
