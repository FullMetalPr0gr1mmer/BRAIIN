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
export const ServiceRowSchema = z.object({
  slug: SlugSchema,
  title: LocalizedTextSchema,
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
  slug: SlugSchema,
  title: LocalizedTextSchema,
  summary: LocalizedProseSchema.nullable(),
  body_html: LocalizedProseSchema.nullable(),
  sort_order: z.number(),
  updated_at: z.string().nullable(),
});
export type PortfolioRow = z.infer<typeof PortfolioRowSchema>;

/** E-E-A-T author (CLAUDE.md Pillar 3 — no anonymous authorship). */
export const TeamMemberRowSchema = z.object({
  slug: SlugSchema,
  name: LocalizedTextSchema,
  bio: LocalizedProseSchema.nullable(),
  avatar_url: z.string().nullable(),
  sort_order: z.number(),
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

/** `value` stays a display string so authored suffixes ('+', '%', 'x') survive verbatim. */
export const StatisticRowSchema = z.object({
  slug: SlugSchema,
  label: LocalizedTextSchema,
  value: z.string(),
  sort_order: z.number(),
});
export type StatisticRow = z.infer<typeof StatisticRowSchema>;

/** Marquee logos have no publish lifecycle — visibility is the `visible` flag. */
export const PartnerLogoRowSchema = z.object({
  name: z.string(),
  logo_url: z.string(),
  sort_order: z.number(),
});
export type PartnerLogoRow = z.infer<typeof PartnerLogoRowSchema>;

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
