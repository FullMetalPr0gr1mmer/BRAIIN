import { z } from 'zod';
import { BilingualTextSchema, SlugSchema } from './primitives';

// The seven public CONTENT shapes, in the one place CLAUDE.md §8 requires:
// "One Zod schema per shape in `packages/schemas`, imported by site, admin, Edge Functions."
// They previously lived inline in `src/lib/data/*.ts`, which made them unreachable from the
// admin and Edge Functions and let each file re-declare its own (weaker) localized type.
//
// ── Why two localized shapes, not one ────────────────────────────────────────────
// The old inline type was `z.record(z.string(), z.string())`, which accepts `{}`,
// `{fr:'x'}`, and — the real defect — an Arabic-less `{en:'x'}`. That contradicts
// Pillar 3 ("AR meta first-class") and Phase 2 ("AR meta/OG Zod-required"): an AR-less
// title renders an English heading at `/ar/...` while hreflang claims the page is Arabic.
//
//   LocalizedTextSchema  — indexable scalars (title/name/label). AR is REQUIRED.
//   LocalizedProseSchema — long-form prose (body/excerpt/bio). AR is OPTIONAL.
//
// The split is deliberate: metadata that drives indexing and hreflang must be bilingual
// on day one, but blocking a whole post because its Arabic body translation is still in
// progress would be a self-inflicted outage. Enforcing the strict half NOW, while there
// is no production content, is the cheap moment — after launch it is a migration.

/** Indexable bilingual scalar — BOTH languages required (title, name, label). */
export const LocalizedTextSchema = BilingualTextSchema;
export type LocalizedText = z.infer<typeof LocalizedTextSchema>;

/** Long-form bilingual prose — EN required, AR may lag translation. */
export const LocalizedProseSchema = z.object({
  en: z.string().min(1),
  ar: z.string().min(1).optional(),
});
export type LocalizedProse = z.infer<typeof LocalizedProseSchema>;

// ── Content rows (shape returned by the public Tier-A read loaders) ──────────────
// Slugs use SlugSchema (kebab-case, ≤120) because they become URLs — a malformed slug
// is a real defect, not a nit. Rows that fail validation are dropped AND logged by
// `src/lib/data/parse.ts`, so a rejection is diagnosable rather than a silent gap.

// `updated_at` feeds the sitemap's <lastmod> and JSON-LD `dateModified`. Pillar 3 calls
// for a TRUTHFUL dateModified, which means it has to come from the row rather than from
// request time — so it is selected here rather than synthesised at render.
// `id` is selected because per-entity SEO (`entity_seo`) is keyed by (entity_type,
// entity_id) — a polymorphic table cannot be FK-embedded from the content row, so the
// loader needs the uuid to fetch the override.
export const ServiceRowSchema = z.object({
  id: z.string().uuid(),
  slug: SlugSchema,
  title: LocalizedTextSchema,
  /** Chip/skill label where it differs from the title (0023). */
  short_title: LocalizedTextSchema.nullable(),
  blurb: LocalizedProseSchema.nullable(),
  body_html: LocalizedProseSchema.nullable(),
  hero_video_uid: z.string().nullable(),
  category: z.string().nullable(),
  is_teaser: z.boolean(),
  sort_order: z.number(),
  updated_at: z.string().nullable(),
});
export type ServiceRow = z.infer<typeof ServiceRowSchema>;

export const PortfolioRowSchema = z.object({
  id: z.string().uuid(),
  slug: SlugSchema,
  title: LocalizedTextSchema,
  summary: LocalizedProseSchema.nullable(),
  body_html: LocalizedProseSchema.nullable(),
  sort_order: z.number(),
  updated_at: z.string().nullable(),
});
export type PortfolioRow = z.infer<typeof PortfolioRowSchema>;

// ── Media as the public loaders see it (0024) ─────────────────────────────────────
// Only columns anon is granted on media_assets — selecting any other column is a
// permission error that empties the whole query, so this list and the grant must agree
// (tests/lib/publicMedia.spec.ts).
export const PUBLIC_MEDIA_COLUMNS = 'id,kind,provider,storage_path,width,height,alt,stream_uid';

export const PublicMediaRowSchema = z.object({
  id: z.string().uuid(),
  kind: z.string(),
  provider: z.enum(['external', 'static', 'cf_images', 'stream']),
  storage_path: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  /** Missing alt renders as decorative (alt="") and is flagged on the dashboard (0025). */
  alt: z.object({ en: z.string().optional(), ar: z.string().optional() }).nullable(),
  stream_uid: z.string().nullable(),
});
export type PublicMediaRow = z.infer<typeof PublicMediaRowSchema>;

/** E-E-A-T author (CLAUDE.md Pillar 3 — no anonymous authorship), and the leadership slider. */
export const TeamMemberRowSchema = z.object({
  slug: SlugSchema,
  name: LocalizedTextSchema,
  bio: LocalizedProseSchema.nullable(),
  avatar_url: z.string().nullable(),
  sort_order: z.number(),
  role: LocalizedTextSchema.nullable(),
  linkedin_url: z.string().nullable(),
  is_leadership: z.boolean(),
  /** A seeded design placeholder (0023). Shown under the 0027 override; never a Person node. */
  is_placeholder: z.boolean(),
  portrait: PublicMediaRowSchema.nullable(),
});
export type TeamMemberRow = z.infer<typeof TeamMemberRowSchema>;

export const CertificationRowSchema = z.object({
  slug: SlugSchema,
  name: LocalizedTextSchema,
  issuer: LocalizedProseSchema.nullable(),
  year: z.number().nullable(),
  logo_url: z.string().nullable(),
  sort_order: z.number(),
});
export type CertificationRow = z.infer<typeof CertificationRowSchema>;

export const STAT_PLACEMENTS = ['home', 'about', 'work'] as const;
export const StatPlacementSchema = z.enum(STAT_PLACEMENTS);
export type StatPlacement = z.infer<typeof StatPlacementSchema>;

/**
 * `value` stays a display string so authored suffixes ('+', '%', 'x') survive verbatim;
 * `value_numeric` + `value_suffix` (0023, CHECK-consistent with `value`) let a band count
 * up. `placement_labels` holds the per-page label where it differs from `label`.
 */
export const StatisticRowSchema = z.object({
  slug: SlugSchema,
  label: LocalizedTextSchema,
  value: z.string(),
  sort_order: z.number(),
  value_numeric: z.number().nullable(),
  value_suffix: z.string().nullable(),
  placements: z.array(z.string()),
  placement_labels: z.record(z.string(), LocalizedTextSchema),
});
export type StatisticRow = z.infer<typeof StatisticRowSchema>;

// Blog embeds its author + category via PostgREST FK embeds (single round-trip, no N+1).
export const PostAuthorSchema = z
  .object({ slug: SlugSchema, name: LocalizedTextSchema, avatar_url: z.string().nullable() })
  .nullable();
export type PostAuthor = z.infer<typeof PostAuthorSchema>;

export const PostCategorySchema = z
  .object({ slug: SlugSchema, name: LocalizedTextSchema })
  .nullable();
export type PostCategory = z.infer<typeof PostCategorySchema>;

export const PostRowSchema = z.object({
  id: z.string().uuid(),
  slug: SlugSchema,
  title: LocalizedTextSchema,
  excerpt: LocalizedProseSchema.nullable(),
  body_html: LocalizedProseSchema.nullable(),
  cover_image_url: z.string().nullable(),
  published_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  reading_minutes: z.number().nullable(),
  author: PostAuthorSchema,
  category: PostCategorySchema,
});
export type PostRow = z.infer<typeof PostRowSchema>;

// ── UI v2 content model (0021–0022) ───────────────────────────────────────────────

export const SectorRowSchema = z.object({
  id: z.string().uuid(),
  slug: SlugSchema,
  name: LocalizedTextSchema,
  sort_order: z.number(),
});
export type SectorRow = z.infer<typeof SectorRowSchema>;

/** A visible client (visibility IS the disclosure permission — fail-closed). */
export const ClientRowSchema = z.object({
  id: z.string().uuid(),
  slug: SlugSchema,
  name: LocalizedTextSchema,
  website_url: z.string().nullable(),
  sort_order: z.number(),
  logo: PublicMediaRowSchema.nullable(),
});
export type ClientRow = z.infer<typeof ClientRowSchema>;

export const TESTIMONIAL_PLACEMENTS = ['home', 'work'] as const;
export const TestimonialPlacementSchema = z.enum(TESTIMONIAL_PLACEMENTS);
export type TestimonialPlacement = z.infer<typeof TestimonialPlacementSchema>;

/** Only the columns anon is granted: never the consent record (0021). */
export const TestimonialRowSchema = z.object({
  id: z.string().uuid(),
  slug: SlugSchema,
  quote: LocalizedTextSchema,
  author_name: LocalizedTextSchema,
  /** "Title, Company" verbatim — there is no company column. */
  author_role: LocalizedTextSchema.nullable(),
  client_id: z.string().uuid().nullable(),
  portfolio_id: z.string().uuid().nullable(),
  placements: z.array(z.string()),
  sort_order: z.number(),
  avatar: PublicMediaRowSchema.nullable(),
});
export type TestimonialRow = z.infer<typeof TestimonialRowSchema>;

/** A case-study result card ("XXM · Views across platforms"). */
export const ResultCardSchema = z.object({
  value: z.string().trim().min(1).max(16),
  label: LocalizedTextSchema,
});
export type ResultCard = z.infer<typeof ResultCardSchema>;

const Seconds = z.number().min(0).max(600);

/** An embedded sector/client: what a facet chip needs, and where it sorts. */
const FacetRefSchema = z.object({
  slug: SlugSchema,
  name: LocalizedTextSchema,
  sort_order: z.number(),
});

/** Everything a project CARD needs (Our Work, All projects, Selected work). */
export const PortfolioCardRowSchema = z.object({
  id: z.string().uuid(),
  slug: SlugSchema,
  title: LocalizedTextSchema,
  project_type: LocalizedTextSchema.nullable(),
  teaser: LocalizedTextSchema.nullable(),
  summary: LocalizedProseSchema.nullable(),
  year: z.number().int().nullable(),
  is_featured: z.boolean(),
  sort_order: z.number(),
  updated_at: z.string().nullable(),
  preview_video_uid: z.string().nullable(),
  preview_video_path: z.string().nullable(),
  preview_start_s: Seconds.nullable(),
  preview_end_s: Seconds.nullable(),
  client_id: z.string().uuid().nullable(),
  poster: PublicMediaRowSchema.nullable(),
  sector: FacetRefSchema.nullable(),
  /** null while client_id is set = RLS hid it (not disclosable) → "Confidential client". */
  client: FacetRefSchema.nullable(),
  services: z.array(
    z.object({
      sort_order: z.number(),
      service: z
        .object({
          slug: SlugSchema,
          title: LocalizedTextSchema,
          short_title: LocalizedTextSchema.nullable(),
          sort_order: z.number(),
        })
        .nullable(),
    }),
  ),
});
export type PortfolioCardRow = z.infer<typeof PortfolioCardRowSchema>;

export const PORTFOLIO_MEDIA_ROLES = ['hero', 'final', 'breakdown', 'gallery'] as const;
export const BREAKDOWN_KINDS = ['sketch', 'bts', 'process'] as const;
export const MEDIA_LAYOUTS = ['half', 'wide', 'third'] as const;

export const PortfolioMediaRowSchema = z.object({
  role: z.enum(PORTFOLIO_MEDIA_ROLES),
  kind: z.enum(['image', 'video']),
  video_uid: z.string().nullable(),
  video_path: z.string().nullable(),
  clip_start_s: Seconds.nullable(),
  clip_end_s: Seconds.nullable(),
  duration_label: z.string().nullable(),
  caption: LocalizedTextSchema.nullable(),
  breakdown_kind: z.enum(BREAKDOWN_KINDS).nullable(),
  layout: z.enum(MEDIA_LAYOUTS).nullable(),
  sort_order: z.number(),
  /** The image, or the video's poster (embedded as `asset:media_id(...)`). */
  asset: PublicMediaRowSchema.nullable(),
});
export type PortfolioMediaRow = z.infer<typeof PortfolioMediaRowSchema>;

/** A card plus the case-study body (`/portfolio/[slug]`). */
export const CaseStudyRowSchema = PortfolioCardRowSchema.extend({
  /**
   * The body's Tiptap SOURCE (locale-keyed JSON), not the `body_html` cache: the public
   * page renders it through the allowlist renderer (CLAUDE.md Pillar 1, "sanitised on
   * write AND render"). Each locale is validated by that renderer (an invalid doc renders
   * ''), so a malformed body drops the body — never the whole case study.
   */
  body: z.object({ en: z.unknown().optional(), ar: z.unknown().optional() }).nullable().catch(null),
  lead: LocalizedTextSchema.nullable(),
  goal: LocalizedTextSchema.nullable(),
  result: LocalizedTextSchema.nullable(),
  scope: z.array(LocalizedTextSchema).max(10),
  keywords: z.array(LocalizedTextSchema).max(6),
  results: z.array(ResultCardSchema).max(4),
  next_portfolio_id: z.string().uuid().nullable(),
  media: z.array(PortfolioMediaRowSchema),
});
export type CaseStudyRow = z.infer<typeof CaseStudyRowSchema>;
