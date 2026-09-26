import { z } from 'zod';
import { LocalizedTextSchema, TestimonialPlacementSchema } from './content';
import { SECTION_TYPES, type SectionType } from './sectionTypes';
import { AccentSchema, SafeHrefSchema } from './media';
import { SlugSchema } from './primitives';

// Per-type CMS content shapes for `page_sections.content` (authored at /admin/sections,
// rendered by src/components/SectionRenderer.astro). One schema per shape, in packages/
// schemas, per CLAUDE.md §8 — imported by the public loader AND available to the admin.
//
// Every field is an OPTIONAL override: a section with `content: {}` renders its
// built-in bilingual copy. Overrides use LocalizedTextSchema (BOTH languages required)
// because this copy is indexable — an AR-less heading would render English at /ar/*
// while hreflang claims the page is Arabic (Pillar 3).
//
// The public loader validates `content` against the section's type and falls back to
// `{}` (built-in copy) when validation fails — bad CMS JSON degrades, never breaks.

const Text = LocalizedTextSchema;

/** Links are CMS-authored and rendered into <a href> — https only, no other schemes. */
const HttpsUrlSchema = z.string().trim().url().startsWith('https://').max(300);

/* The hero headline is split into per-word / per-letter spans whose entrance stagger is
   an enumerated CSS ladder (10 word rungs x 14 letter rungs — global.css). Bounding the
   input HERE is what keeps that ladder complete: past its last rung the stagger flattens
   into a simultaneous pop and `--bs-hero-lead` stops being a real upper bound on when
   the headline has arrived. It also bounds the number of composited spans inside the
   LCP element — LocalizedTextSchema has no `.max()`, so a 500-word headline validates
   today. The loader falls back to built-in copy on failure, so this degrades, never
   breaks. */
const HERO_MAX_WORDS = 10;
const HERO_MAX_WORD_LEN = 14;
const heroHeadlineShape = (s: string): boolean => {
  const words = s.trim().split(/\s+/).filter(Boolean);
  return (
    words.length > 0 &&
    words.length <= HERO_MAX_WORDS &&
    // per code point, matching Hero.astro's `[...w.text]` split
    words.every((w) => [...w].length <= HERO_MAX_WORD_LEN)
  );
};

export const HeroSectionContentSchema = z.object({
  /** Cloudflare Stream UID for the hero loop (KAN-20). */
  videoUid: z.string().trim().max(120).optional(),
  headline: Text.refine((v) => heroHeadlineShape(v.en) && heroHeadlineShape(v.ar), {
    message: `Hero headline: at most ${HERO_MAX_WORDS} words, and ${HERO_MAX_WORD_LEN} characters per word (the CSS entrance ladder has that many rungs).`,
  }).optional(),
  /** 0-based word index where the accent colour starts, per locale. */
  accentFromEn: z.number().int().min(0).max(30).optional(),
  accentFromAr: z.number().int().min(0).max(30).optional(),
  sub: Text.optional(),
  ctaLabel: Text.optional(),
  /** Logo intro plate. Home only, opt-in — drives `body:has(.intro)` in global.css. */
  intro: z.boolean().optional(),
});

export const AboutIntroSectionContentSchema = z.object({
  tag: Text.optional(),
  heading: Text.optional(),
  lead: Text.optional(),
  columns: z
    .array(z.object({ title: Text, body: Text }))
    .max(6)
    .optional(),
});

export const SloganSectionContentSchema = z.object({
  text: Text.optional(),
  accentFromEn: z.number().int().min(0).max(30).optional(),
  accentFromAr: z.number().int().min(0).max(30).optional(),
});

export const ClientsMarqueeSectionContentSchema = z.object({
  tag: Text.optional(),
  heading: Text.optional(),
  note: Text.optional(),
});

export const ServicesOverviewSectionContentSchema = z.object({
  tag: Text.optional(),
  heading: Text.optional(),
  sub: Text.optional(),
});

export const ContactSectionContentSchema = z.object({
  heading: Text.optional(),
  accent: Text.optional(),
});

export const SocialSectionContentSchema = z.object({
  tag: Text.optional(),
  heading: Text.optional(),
  links: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(40),
        user: z.string().trim().min(1).max(60),
        href: HttpsUrlSchema,
      }),
    )
    .max(8)
    .optional(),
});

export const CtaSectionContentSchema = z.object({
  heading: Text.optional(),
  text: Text.optional(),
  buttonLabel: Text.optional(),
});

/**
 * A statistics band (UI v2). The numbers come from the `statistics` table, filtered to the
 * counters shown on `placement` and labelled for that page; this is only the layout and
 * the copy around them. `cards` is the pre-UI-v2 grid (the default, so an existing
 * composition renders unchanged).
 */
export const STAT_BAND_VARIANTS = ['cards', 'band', 'reach', 'proof'] as const;
export const StatisticsSectionContentSchema = z
  .object({
    variant: z.enum(STAT_BAND_VARIANTS).optional(),
    placement: z.enum(['home', 'about', 'work']).optional(),
    tag: Text.optional(),
    heading: Text.optional(),
    accent: AccentSchema.optional(),
    text: Text.optional(),
    /**
     * Show the numbers without the count-up. An opt-OUT, because an editor's unticked box is
     * "not set": counting up (an enhancement over server-rendered final values) is the default.
     */
    staticNumbers: z.boolean().optional(),
    /** Fewer published counters than this and the band hides (an under-filled row looks broken). */
    minItems: z.number().int().min(1).max(6).optional(),
  })
  // Strict: its numbers come from their own table, and a stray key (`items`, `members`)
  // must be refused on write rather than stored and silently ignored.
  .strict();

/**
 * Home "Selected work" (UI v2 PR7). The projects come from the portfolio table — the
 * published `is_featured` ones, in `sort_order` — never from this content: the first is
 * the featured project, the next two the cards. `featuredSlug` / `cardSlugs` only
 * re-pick among the featured projects (an unknown or unfeatured slug is ignored, so a
 * stale pick degrades to the default order instead of an empty band).
 */
export const SelectedWorkSectionContentSchema = z
  .object({
    tag: Text.optional(),
    heading: Text.optional(),
    accent: AccentSchema.optional(),
    /** The numbered statements beside the heading ("Made to be remembered…"). */
    lines: z
      .array(z.object({ text: Text }))
      .max(3)
      .optional(),
    featuredSlug: SlugSchema.optional(),
    cardSlugs: z.array(SlugSchema).max(2).optional(),
    /** The featured project's link ("See the project"). */
    featuredLinkLabel: Text.optional(),
    /** The closing button ("See all our work" → /portfolio). */
    button: z.object({ label: Text.optional(), href: SafeHrefSchema.optional() }).optional(),
  })
  // Strict, like statistics: its projects come from their own table, and a stray key
  // (`cards`, `items`) must be refused on write rather than stored and ignored.
  .strict();

/**
 * Client quotes as a carousel (UI v2 PR7) — the home Klein band. The quotes come from the
 * `testimonials` table (published, placed on `placement`); this is the layout and the
 * copy around them. No quotes, no section.
 */
export const TestimonialsSectionContentSchema = z
  .object({
    variant: z.enum(['klein', 'light']).optional(),
    placement: TestimonialPlacementSchema.optional(),
    tag: Text.optional(),
    heading: Text.optional(),
    accent: AccentSchema.optional(),
    /** How long each quote stays (the design's 7 s by default). */
    intervalMs: z.number().int().min(4000).max(15000).optional(),
    limit: z.number().int().min(1).max(8).optional(),
  })
  .strict();

export const AboutStorySectionContentSchema = z.object({
  heading: Text.optional(),
  lead: Text.optional(),
  missionTitle: Text.optional(),
  mission: Text.optional(),
  visionTitle: Text.optional(),
  vision: Text.optional(),
});

export { SECTION_TYPES, type SectionType } from './sectionTypes';
/** Zod form of the canonical list in ./sectionTypes (kept zod-free for the admin bundle). */
export const SectionTypeSchema = z.enum(SECTION_TYPES);

/** type → content schema. Types absent here (team, certifications, …) take no
    content overrides — their data comes from their own CMS tables. */
export const SECTION_CONTENT_SCHEMAS: Partial<Record<SectionType, z.ZodTypeAny>> = {
  hero: HeroSectionContentSchema,
  aboutIntro: AboutIntroSectionContentSchema,
  slogan: SloganSectionContentSchema,
  clientsMarquee: ClientsMarqueeSectionContentSchema,
  servicesOverview: ServicesOverviewSectionContentSchema,
  contact: ContactSectionContentSchema,
  social: SocialSectionContentSchema,
  cta: CtaSectionContentSchema,
  aboutStory: AboutStorySectionContentSchema,
  statistics: StatisticsSectionContentSchema,
  selectedWork: SelectedWorkSectionContentSchema,
  testimonials: TestimonialsSectionContentSchema,
};

/**
 * Validates one section's `content` against its type, for WRITES. Returns the issues
 * with `content`-rooted paths so the admin can point at the offending field.
 *
 * A type with no content schema takes NO overrides at all: `{}` only. Its data comes
 * from its own table, and SectionRenderer spreads content into component props — a
 * stray `members` or `items` key would otherwise replace the table-backed data on a
 * public page.
 */
export function sectionContentIssues(type: SectionType, content: unknown): z.ZodIssue[] {
  const schema = SECTION_CONTENT_SCHEMAS[type];
  if (!schema) {
    const empty =
      typeof content === 'object' && content !== null && Object.keys(content).length === 0;
    return empty
      ? []
      : [
          {
            code: z.ZodIssueCode.custom,
            path: ['content'],
            message: `section type '${type}' takes no content overrides — its data comes from its own table`,
          },
        ];
  }
  const parsed = schema.safeParse(content);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => ({ ...issue, path: ['content', ...issue.path] }));
}

/** Public row shape for the Tier-A page_sections read (see PageSectionRow loaders). */
export const PageSectionRowSchema = z.object({
  type: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-zA-Z][a-zA-Z0-9]*$/),
  content: z.record(z.string(), z.unknown()),
  visible: z.boolean(),
  sort_order: z.number(),
});
export type PageSectionRow = z.infer<typeof PageSectionRowSchema>;

export type HeroSectionContent = z.infer<typeof HeroSectionContentSchema>;
export type AboutIntroSectionContent = z.infer<typeof AboutIntroSectionContentSchema>;
export type SloganSectionContent = z.infer<typeof SloganSectionContentSchema>;
export type ClientsMarqueeSectionContent = z.infer<typeof ClientsMarqueeSectionContentSchema>;
export type ServicesOverviewSectionContent = z.infer<typeof ServicesOverviewSectionContentSchema>;
export type ContactSectionContent = z.infer<typeof ContactSectionContentSchema>;
export type SocialSectionContent = z.infer<typeof SocialSectionContentSchema>;
export type CtaSectionContent = z.infer<typeof CtaSectionContentSchema>;
export type AboutStorySectionContent = z.infer<typeof AboutStorySectionContentSchema>;
export type SelectedWorkSectionContent = z.infer<typeof SelectedWorkSectionContentSchema>;
export type TestimonialsSectionContent = z.infer<typeof TestimonialsSectionContentSchema>;
