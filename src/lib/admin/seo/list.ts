import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { IDENTITY_FALLBACK } from '@/lib/identity/fallback';
import { DEFAULT_TITLE_TEMPLATE } from '@/lib/seo/title';
import { entityPath, type SeoEntityType } from '@/lib/seo/entityPaths';
import { isNoindex, pageRobots } from '@/lib/seo/robots';
import { ENTITY_SEO, SEO_ENTITY_TYPES, targetTable } from '../entitySeo';
import { defaultsFor, type TargetRow } from './defaults';

// The SEO screen's Pages list (Admin v2 U10, AV-19: `GET /api/admin/entity-seo/list`): one
// page of pages, services, projects or posts, each with its SEO row and the defaults the
// public head would use where that row is blank (src/lib/admin/seo/defaults.ts), so the
// table can say Custom or Default per field, whether the page is indexed, and whether its
// Arabic is complete. SERVER ONLY. Every read is the caller's own (RLS decides), tenant-
// scoped, in two rounds: the targets (one page, with an exact count), then their SEO rows,
// the tenant's SEO defaults and the brand together. Archived targets are left out; drafts are
// listed with their status.

export const SEO_LIST_MAX = 100;
export const SEO_LIST_DEFAULT = 50;
export const SEO_LIST_Q_MAX = 64;

/** The query string. Coerced (query params are strings); `q` holds no control characters. */
export const SeoListQuerySchema = z.object({
  type: z.enum(SEO_ENTITY_TYPES).default('page'),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(SEO_LIST_MAX).default(SEO_LIST_DEFAULT),
  q: z
    .string()
    .trim()
    .max(SEO_LIST_Q_MAX)
    // eslint-disable-next-line no-control-regex
    .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), 'no control characters')
    .optional(),
});
export type SeoListQuery = z.infer<typeof SeoListQuerySchema>;

type Bi = { en: string; ar: string };

export interface SeoListRow {
  /** `<type>:<entityId>`: the table's row key. */
  id: string;
  entityType: SeoEntityType;
  entityId: string;
  label: string;
  slug: string;
  status: string;
  /** The logical public path (EN), or null for a page no route renders. */
  path: string | null;
  /** The SEO row's version (0: no row yet). */
  version: number;
  /** The row's own value, read into the closed set (null: follow the site default). */
  robots: 'index,follow' | 'noindex,follow' | null;
  /** What the head says: the row's, else the site default. */
  indexed: boolean;
  canonicalOverride: string | null;
  ogMediaId: string | null;
  ogImage: string | null;
  title: { custom: Bi | null; default: Bi };
  description: { custom: Bi | null; default: Bi };
  /** Every field the head shows in Arabic has Arabic text (custom or default). */
  arabicComplete: boolean;
}

export interface SeoListPage {
  type: SeoEntityType;
  total: number;
  offset: number;
  limit: number;
  rows: SeoListRow[];
  brand: Bi;
  titleTemplate: Bi;
  defaultRobots: string;
}

/** A `{en, ar}` json column as a pair, or null when neither half is written. */
function customPair(value: unknown): Bi | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const en = typeof record['en'] === 'string' ? record['en'].trim() : '';
  const ar = typeof record['ar'] === 'string' ? record['ar'].trim() : '';
  return en || ar ? { en, ar } : null;
}

function bi(value: unknown, fallback: Bi): Bi {
  const pair = customPair(value);
  return { en: pair?.en || fallback.en, ar: pair?.ar || fallback.ar };
}

/**
 * A search term as a PostgREST `ilike` value: LIKE's own wildcards and escape are escaped,
 * then the whole value is double-quoted for the `or` filter (a comma or a parenthesis in it
 * would otherwise end the condition).
 */
export function ilikeValue(q: string): string {
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return `"${like.replace(/["\\]/g, (c) => `\\${c}`)}"`;
}

export async function listEntitySeo(
  sb: SupabaseClient,
  auth: AuthContext,
  query: SeoListQuery,
): Promise<SeoListPage> {
  const { type, offset, limit } = query;
  const { table, columns } = targetTable(type);
  let targets = sb
    .from(table)
    .select(columns, { count: 'exact' })
    .eq('tenant_id', auth.tenantId)
    .neq('status', 'archived');
  if (query.q) {
    const value = ilikeValue(query.q);
    targets = targets.or(`slug.ilike.${value},title->>en.ilike.${value}`);
  }
  const ordered =
    type === 'blog_post'
      ? targets.order('updated_at', { ascending: false })
      : type === 'page'
        ? targets.order('slug', { ascending: true })
        : targets.order('sort_order', { ascending: true });
  const { data, count, error } = await ordered
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`read ${table}: ${error.message}`);
  const rows = (data ?? []) as unknown as TargetRow[];
  const ids = rows.map((row) => row.id);

  const [seo, defaults, profile] = await Promise.all([
    ids.length === 0
      ? Promise.resolve({ data: [], error: null })
      : sb
          .from(ENTITY_SEO.table)
          .select(ENTITY_SEO.COLUMNS)
          .eq('tenant_id', auth.tenantId)
          .eq('entity_type', type)
          .in('entity_id', ids),
    sb
      .from('seo_defaults')
      .select('title_template,default_title,default_description,robots_directives')
      .eq('tenant_id', auth.tenantId)
      .maybeSingle(),
    sb.from('site_profile').select('brand_name').eq('tenant_id', auth.tenantId).maybeSingle(),
  ]);
  if (seo.error) throw new Error(`read entity_seo: ${seo.error.message}`);
  if (defaults.error) throw new Error(`read seo_defaults: ${defaults.error.message}`);
  // The brand only names the preview; the code identity stands in if the row is unreadable.
  const brand = bi(
    (profile.data as { brand_name?: unknown } | null)?.brand_name,
    IDENTITY_FALLBACK.brandName,
  );
  const tenantDefaults = defaults.data as {
    title_template?: Record<string, string> | null;
    default_title?: Record<string, string> | null;
    default_description?: Record<string, string> | null;
    robots_directives?: string | null;
  } | null;
  const defaultRobots = tenantDefaults?.robots_directives ?? 'index,follow';
  const byTarget = new Map(
    ((seo.data ?? []) as Record<string, unknown>[]).map((row) => [String(row['entity_id']), row]),
  );

  return {
    type,
    total: count ?? rows.length,
    offset,
    limit,
    brand,
    titleTemplate: bi(tenantDefaults?.title_template, {
      en: DEFAULT_TITLE_TEMPLATE,
      ar: DEFAULT_TITLE_TEMPLATE,
    }),
    defaultRobots,
    rows: rows.map((target) => {
      const row = byTarget.get(target.id);
      const fallback = defaultsFor(type, target, tenantDefaults);
      const title = customPair(row?.['meta_title']);
      const description = customPair(row?.['meta_description']);
      const stored = (row?.['robots'] as string | null | undefined) ?? null;
      const shownTitle = { ar: title?.ar || fallback.title.ar };
      const shownDescription = { ar: description?.ar || fallback.description.ar };
      return {
        id: `${type}:${target.id}`,
        entityType: type,
        entityId: target.id,
        label: target.title?.en || target.title?.ar || target.slug,
        slug: target.slug,
        status: target.status,
        path: entityPath(type, target.slug),
        version: Number(row?.['version'] ?? 0),
        robots: pageRobots(stored),
        indexed: !isNoindex(stored ?? defaultRobots),
        canonicalOverride: (row?.['canonical_override'] as string | null | undefined) ?? null,
        ogMediaId: (row?.['og_media_id'] as string | null | undefined) ?? null,
        ogImage: (row?.['og_image'] as string | null | undefined) ?? null,
        title: { custom: title, default: fallback.title },
        description: { custom: description, default: fallback.description },
        arabicComplete: Boolean(shownTitle.ar && shownDescription.ar),
      };
    }),
  };
}
