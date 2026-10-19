import { z } from 'zod';
import { PUBLIC_MEDIA_COLUMNS, PublicMediaRowSchema } from '@schemas/content';
import type { Locale } from '@schemas/primitives';
import { supabaseConfigured } from '@/lib/supabase/client';
import { DEFAULT_TITLE_TEMPLATE, applyTitleTemplate } from '@/lib/seo/title';
import { contentClient } from './source';

// Public read path for CMS-authored SEO: per-entity overrides (`entity_seo`) and the
// tenant's global defaults (`seo_defaults`).
//
// This is what makes the SEO role's work reach a visitor. Without it the SEO editor
// would be writing to a table nothing reads — a CMS surface that appears to work and
// changes nothing, which is worse than not shipping it.
//
// Both tables are readable by anon under RLS on purpose: their entire content ends up
// in the HTML head of a public page, so there is nothing here to withhold.
//
// The share images from the media library (Admin v2 U10, 0073) arrive in the same query, as
// an embed of the asset (PUBLIC_MEDIA_COLUMNS only): anon reads a media row only while
// something public names it (0073's media_assets_public_read branches), so a row the visitor
// may not read embeds null and the next candidate is used. No extra round trip.

/** An embedded media row, or null when there is none (or it is not one a visitor reads). */
const EmbeddedMediaSchema = z.preprocess(
  (value) => (Array.isArray(value) ? (value[0] ?? null) : value),
  PublicMediaRowSchema.nullable().catch(null),
);

export type EntityType = 'service' | 'blog_post' | 'portfolio' | 'page';

const LocalizedSchema = z.record(z.string(), z.string()).nullable().optional();

const EntitySeoSchema = z.object({
  meta_title: LocalizedSchema,
  meta_description: LocalizedSchema,
  og_image: z.string().nullable(),
  og_media: EmbeddedMediaSchema.optional(),
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
  default_og_media: EmbeddedMediaSchema.optional(),
  robots_directives: z.string(),
});
export type SeoDefaults = z.infer<typeof SeoDefaultsSchema>;

export interface ResolvedSeo {
  title: string;
  description: string;
  /**
   * The share-image candidates this layer knows, kept APART: between them sits the page's
   * own image (a poster, a banner, a cover), which only the page has — see
   * src/lib/seo/ogImage.ts for the order. Blank values are unset.
   */
  entityOgImage: string | undefined;
  defaultOgImage: string | undefined;
  canonicalOverride: string | undefined;
  robots: string;
}

/** An authored value, or undefined when it is missing or only whitespace. */
const nonBlank = (value: string | null | undefined): string | undefined =>
  value?.trim() || undefined;

export async function getEntitySeo(
  entityType: EntityType,
  entityId: string,
): Promise<EntitySeo | null> {
  if (!supabaseConfigured()) return null;
  try {
    const { data, error } = await contentClient()
      .from('entity_seo')
      .select(
        `meta_title,meta_description,og_image,canonical_override,robots,schema_type,og_media:media_assets(${PUBLIC_MEDIA_COLUMNS})`,
      )
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
    const { data, error } = await contentClient()
      .from('seo_defaults')
      .select(
        `title_template,default_title,default_description,default_og_image,robots_directives,default_og_media:media_assets(${PUBLIC_MEDIA_COLUMNS})`,
      )
      .maybeSingle();
    if (error || !data) return null;
    const parsed = SeoDefaultsSchema.safeParse(data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the head values for one page. Precedence, per field:
 *
 *   title        entity override → the page's own title → tenant default title
 *   description  entity override → the page's own blurb → tenant default description
 *   share image  entity override (its media-library picture, else its legacy URL) → the
 *                page's own image → tenant default (picture, else legacy URL) → the code
 *                default (the logo card) — resolved by src/lib/seo/ogImage.ts, since only
 *                the page knows its own image; this returns the two authored ends apart
 *
 * The page's own value outranks the tenant default. The default is the LAST resort for a
 * page that has nothing of its own; ranked above the page title (as it was before UI v2),
 * authoring a default title would have given every service, article and project on the
 * site the same <title> — and, until 2026-10, an authored default share image would have
 * replaced every service poster and case-study banner in link previews the same way.
 *
 * The title then goes through the template (`seo_defaults.title_template`, default
 * `%brand% | %s`) — see src/lib/seo/title.ts for `%brand%`, and why a title that already
 * names the brand is left alone.
 *
 * ── Why Arabic does NOT fall back to English ─────────────────────────────────────
 * Everywhere else in this codebase a missing Arabic string falls back to English,
 * because half-translated body copy still communicates. Metadata is the exception, and
 * `<SeoHead>` already documents the reason: the page declares `lang="ar"` and
 * `og:locale=ar_SA`, so an English description under those signals is a WORSE input to
 * a search engine than no description at all. An empty string here makes SeoHead omit
 * the tag, which is the honest outcome.
 */
export function resolveSeo(options: {
  locale: Locale;
  brand: string;
  entity: EntitySeo | null;
  defaults: SeoDefaults | null;
  fallbackTitle: string;
  fallbackDescription?: string;
  /**
   * The share images from the media library as absolute URLs (src/lib/seo/head.ts makes them
   * from `og_media` / `default_og_media`). Each outranks its own legacy URL column.
   */
  shareImages?: { entity?: string | undefined; defaults?: string | undefined };
}): ResolvedSeo {
  const {
    locale,
    brand,
    entity,
    defaults,
    fallbackTitle,
    fallbackDescription = '',
    shareImages = {},
  } = options;

  const pick = (record: Record<string, string> | null | undefined): string =>
    (record?.[locale] ?? '').trim();

  const rawTitle =
    pick(entity?.meta_title) || fallbackTitle.trim() || pick(defaults?.default_title);
  const template = pick(defaults?.title_template) || DEFAULT_TITLE_TEMPLATE;

  const description =
    pick(entity?.meta_description) ||
    fallbackDescription.trim() ||
    pick(defaults?.default_description);

  return {
    title: applyTitleTemplate(template, rawTitle, brand),
    description: description.replace(/%brand%/g, () => brand),
    entityOgImage: shareImages.entity ?? nonBlank(entity?.og_image),
    defaultOgImage: shareImages.defaults ?? nonBlank(defaults?.default_og_image),
    canonicalOverride: entity?.canonical_override ?? undefined,
    robots: entity?.robots ?? defaults?.robots_directives ?? 'index,follow',
  };
}

const SeoRuleRowSchema = z.object({
  entity_type: z.enum(['service', 'blog_post', 'portfolio', 'page']),
  entity_id: z.string(),
  robots: z.string().nullable(),
  canonical_override: z.string().nullable(),
});
export type SeoRuleRow = z.infer<typeof SeoRuleRowSchema>;

const PageIdRowSchema = z.object({ id: z.string(), slug: z.string() });

/**
 * What the sitemap and llms.txt need to leave a page out (Admin v2 U10 D8): every SEO row a
 * visitor reads that sets robots or a canonical (RLS keeps them to published pages), and the
 * published pages' ids by slug (a static route's SEO row is its page's). Two reads, started
 * together; null when either fails, and the caller then lists as before (the page's own head
 * still says noindex, so a failed read costs a sitemap line, never a hidden page shown).
 */
export async function getSeoRules(): Promise<{
  rules: SeoRuleRow[];
  pages: { id: string; slug: string }[];
} | null> {
  if (!supabaseConfigured()) return null;
  try {
    const [rules, pages] = await Promise.all([
      contentClient().from('entity_seo').select('entity_type,entity_id,robots,canonical_override'),
      contentClient().from('pages').select('id,slug').eq('status', 'published'),
    ]);
    if (rules.error || pages.error) return null;
    return {
      rules: (rules.data ?? []).flatMap((row) => {
        const parsed = SeoRuleRowSchema.safeParse(row);
        return parsed.success &&
          (parsed.data.robots !== null || parsed.data.canonical_override !== null)
          ? [parsed.data]
          : [];
      }),
      pages: (pages.data ?? []).flatMap((row) => {
        const parsed = PageIdRowSchema.safeParse(row);
        return parsed.success ? [parsed.data] : [];
      }),
    };
  } catch {
    return null;
  }
}
