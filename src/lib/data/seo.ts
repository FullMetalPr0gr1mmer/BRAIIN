import { z } from 'zod';
import type { Locale } from '@schemas/primitives';
import { anonClient, supabaseConfigured } from '@/lib/supabase/client';

// Public read path for CMS-authored SEO: per-entity overrides (`entity_seo`) and the
// tenant's global defaults (`seo_defaults`).
//
// This is what makes the SEO role's work reach a visitor. Without it the SEO editor
// would be writing to a table nothing reads — a CMS surface that appears to work and
// changes nothing, which is worse than not shipping it.
//
// Both tables are readable by anon under RLS on purpose: their entire content ends up
// in the HTML head of a public page, so there is nothing here to withhold.

export type EntityType = 'service' | 'blog_post' | 'portfolio' | 'page';

const LocalizedSchema = z.record(z.string(), z.string()).nullable().optional();

const EntitySeoSchema = z.object({
  meta_title: LocalizedSchema,
  meta_description: LocalizedSchema,
  og_image: z.string().nullable(),
  canonical_override: z.string().nullable(),
  robots: z.string().nullable(),
  schema_type: z.string().nullable(),
});
export type EntitySeo = z.infer<typeof EntitySeoSchema>;

const SeoDefaultsSchema = z.object({
  title_template: LocalizedSchema,
  default_title: LocalizedSchema,
  default_description: LocalizedSchema,
  default_og_image: z.string().nullable(),
  robots_directives: z.string(),
});
export type SeoDefaults = z.infer<typeof SeoDefaultsSchema>;

export interface ResolvedSeo {
  title: string;
  description: string;
  ogImage: string | undefined;
  canonicalOverride: string | undefined;
  robots: string;
}

export async function getEntitySeo(
  entityType: EntityType,
  entityId: string,
): Promise<EntitySeo | null> {
  if (!supabaseConfigured()) return null;
  try {
    const { data, error } = await anonClient()
      .from('entity_seo')
      .select('meta_title,meta_description,og_image,canonical_override,robots,schema_type')
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .maybeSingle();
    if (error || !data) return null;
    const parsed = EntitySeoSchema.safeParse(data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function getSeoDefaults(): Promise<SeoDefaults | null> {
  if (!supabaseConfigured()) return null;
  try {
    const { data, error } = await anonClient()
      .from('seo_defaults')
      .select('title_template,default_title,default_description,default_og_image,robots_directives')
      .maybeSingle();
    if (error || !data) return null;
    const parsed = SeoDefaultsSchema.safeParse(data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the head values for one page: entity override → global default → the
 * content's own title, in that order.
 *
 * ── Why Arabic does NOT fall back to English ─────────────────────────────────────
 * Everywhere else in this codebase a missing Arabic string falls back to English,
 * because half-translated body copy still communicates. Metadata is the exception, and
 * `<SeoHead>` already documents the reason: the page declares `lang="ar"` and
 * `og:locale=ar_SA`, so an English description under those signals is a WORSE input to
 * a search engine than no description at all. An empty string here makes SeoHead omit
 * the tag, which is the honest outcome.
 */
/**
 * One call for a detail page: fetch the entity override + the tenant defaults, resolve,
 * and hand back exactly what `<BaseLayout>` needs.
 *
 * Two queries rather than one. `entity_seo` is polymorphic — keyed by (entity_type,
 * entity_id) — so PostgREST cannot embed it from the content row the way it embeds an
 * author or a category. Both reads are anon, tenant-scoped and land on a Tier-A route
 * whose response is edge-cached for a year and purged by tag on publish, so the cost is
 * paid once per publish rather than once per visitor.
 *
 * Never throws: a SEO lookup failing must not 500 a content page. The fallbacks are the
 * content's own title and blurb, which is what the page used before this existed.
 */
export async function seoForEntity(options: {
  entityType: EntityType;
  entityId: string;
  locale: Locale;
  fallbackTitle: string;
  fallbackDescription?: string;
}): Promise<ResolvedSeo> {
  const [entity, defaults] = await Promise.all([
    getEntitySeo(options.entityType, options.entityId),
    getSeoDefaults(),
  ]);
  return resolveSeo({
    locale: options.locale,
    entity,
    defaults,
    fallbackTitle: options.fallbackTitle,
    ...(options.fallbackDescription === undefined
      ? {}
      : { fallbackDescription: options.fallbackDescription }),
  });
}

export function resolveSeo(options: {
  locale: Locale;
  entity: EntitySeo | null;
  defaults: SeoDefaults | null;
  fallbackTitle: string;
  fallbackDescription?: string;
}): ResolvedSeo {
  const { locale, entity, defaults, fallbackTitle, fallbackDescription = '' } = options;

  const pick = (record: Record<string, string> | null | undefined): string =>
    (record?.[locale] ?? '').trim();

  const rawTitle =
    pick(entity?.meta_title) || pick(defaults?.default_title) || fallbackTitle.trim();

  const template = pick(defaults?.title_template);
  // `%s` is substituted only when the template actually contains it — a template
  // authored without the placeholder would otherwise silently discard the page title.
  const title = template.includes('%s') ? template.replace('%s', rawTitle) : rawTitle;

  const description =
    pick(entity?.meta_description) ||
    pick(defaults?.default_description) ||
    fallbackDescription.trim();

  return {
    title,
    description,
    ogImage: entity?.og_image ?? defaults?.default_og_image ?? undefined,
    canonicalOverride: entity?.canonical_override ?? undefined,
    robots: entity?.robots ?? defaults?.robots_directives ?? 'index,follow',
  };
}
