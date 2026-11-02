import type { SupabaseClient } from '@supabase/supabase-js';
import { PageUpdateSchema, PageWriteSchema } from '@schemas/admin';
import type { AuthContext } from '@/lib/auth/types';
import { CUSTOM_PAGE_ADDRESS_FIXED, isCustomPageSlug } from '@schemas/customPages';
import { ValidationError } from '../errors';
import type { HookResult, ResourceConfig } from '../resource';
import { resyncRedirectTarget } from '../visibilitySync';
import {
  STAMPED,
  fieldsOf,
  pick,
  publishStamp,
  requireBilingual,
  statusOf,
  type Input,
} from './shared';

// Pages. `navVisible` stays a key while `nav_visible` is a column the release registry
// classifies (0038's page row); no screen sends it since page visibility (Admin v2 U14a)
// replaced the "Show in navigation" checkbox, and nothing public reads it.

/**
 * A custom page that stopped or started rendering (its status moved, or it was deleted) may be
 * where a hidden page sends its visitors: the edge's visibility snapshot follows at once
 * (Admin v2 E11 code review, CR1; visibilitySync.ts resyncRedirectTarget). A route page renders
 * whatever its status, so it never needs it. The audit detail says whether the edge took it.
 */
async function followRedirects(
  ctx: { sb: SupabaseClient; auth: AuthContext },
  row: Record<string, unknown>,
  deleted = false,
): Promise<HookResult> {
  const slug = typeof row['slug'] === 'string' ? row['slug'].toLowerCase() : '';
  if (!isCustomPageSlug(slug) || typeof row['id'] !== 'string') return {};
  const sync = await resyncRedirectTarget(ctx.sb, ctx.auth, { id: row['id'], slug }, { deleted });
  return sync === null ? {} : { visibilityKvSynced: sync.kvSynced };
}

const PAGE_KEYS = {
  slug: 'slug',
  title: 'title',
  status: 'status',
  navVisible: 'nav_visible',
  scheduledFor: 'scheduled_for',
};

export const pageResource: ResourceConfig = {
  table: 'pages',
  entity: 'page',
  writeCap: 'pages.write',
  readCaps: ['pages.write', 'seo.entityMeta', 'maintenance.manage'],
  listColumns: 'id,slug,title,status,version,updated_at',
  columns:
    'id,slug,title,status,nav_visible,version,published_at,scheduled_for,created_at,updated_at',
  orderBy: { column: 'slug', ascending: true },
  searchColumn: 'slug',
  createSchema: PageWriteSchema,
  updateSchema: PageUpdateSchema,
  toRow: (input) => publishStamp(pick(input as Input, PAGE_KEYS)),
  fields: fieldsOf(PAGE_KEYS, STAMPED),
  statusOf: (input) => statusOf(input as Input),
  assertPublishable: (row) => requireBilingual(row, 'title', 'Page title'),
  // A custom page's address never changes, and no page takes one by rename (Admin v2 E11 code
  // review, CR3): the New page dialog says the address is chosen once, a rename would leave the
  // old `/<slug>` in the edge cache (a save purges the new `page:<slug>` only), and a page
  // renamed INTO a custom address would bring sections the custom set refuses (the section
  // routes check the set as a section joins a page, never as its page moves). Judged on the
  // stored row, so a save that restates the address passes; the live PATCH and a staged one
  // (a release's validation runs the same rule) alike. 0057's trigger already keeps the route
  // pages, and any page with a visibility setting, at their addresses for every writer.
  assertWritable: (merged, { changed, before }) => {
    if (!before || !('slug' in changed)) return;
    const was = typeof before['slug'] === 'string' ? before['slug'].toLowerCase() : '';
    const now = typeof merged['slug'] === 'string' ? merged['slug'].toLowerCase() : '';
    if (was === now) return;
    if (isCustomPageSlug(was) || isCustomPageSlug(now)) {
      throw new ValidationError(CUSTOM_PAGE_ADDRESS_FIXED, 'slug');
    }
  },
  afterWrite: async ({ auth, sb, row, operation, before }) =>
    operation === 'update' && before && before['status'] !== row['status']
      ? followRedirects({ sb, auth }, row)
      : {},
  afterDelete: async ({ auth, sb, row }) => followRedirects({ sb, auth }, row, true),
  // 0057: the pages the public routes render keep their slugs (page visibility is stored by
  // page id and enforced by slug at the edge), and so does any page that has a setting.
  constraintFields: {
    pages_route_slug_fixed: {
      field: 'slug',
      message: 'This page’s address is part of the site’s routes and cannot change.',
    },
    // Admin v2 E11 (0123, app.tg_pages_slug_rules): the address of a new or renamed page.
    pages_slug_shape: {
      field: 'slug',
      message: 'Use lowercase letters, digits and single hyphens, at most 64 characters.',
    },
    pages_slug_reserved: {
      field: 'slug',
      message: 'The site already uses this address. Choose another one.',
    },
    // 0001's unique key: another page of the site has this address.
    pages_tenant_id_slug_key: {
      field: 'slug',
      message: 'Another page already has this address. Choose another one.',
    },
  },
};
