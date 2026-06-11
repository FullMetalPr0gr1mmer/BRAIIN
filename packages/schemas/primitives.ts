import { z } from 'zod';

// Shared primitive shapes. Zod is the SINGLE content/validation boundary
// (CLAUDE.md §8) imported by the site, the admin, and Edge Functions.

export const LOCALES = ['en', 'ar'] as const;
export const LocaleSchema = z.enum(LOCALES);
export type Locale = z.infer<typeof LocaleSchema>;

/** One lifecycle enum for all content. Gaming teaser = published + isTeaser, NOT a 5th status. */
export const ContentStatusSchema = z.enum(['draft', 'scheduled', 'published', 'archived']);
export type ContentStatus = z.infer<typeof ContentStatusSchema>;

export const UuidSchema = z.string().uuid();

export const SlugSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be lowercase kebab-case');

/** Bilingual scalar (EN + AR). AR is first-class — required for indexable meta. */
export const BilingualTextSchema = z.object({
  en: z.string().min(1),
  ar: z.string().min(1),
});
export type BilingualText = z.infer<typeof BilingualTextSchema>;

/** Optimistic-locking token sent back on every update (WHERE version = $expected → 409). */
export const VersionTokenSchema = z.string().min(1);
