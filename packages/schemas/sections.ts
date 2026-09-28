import { z } from 'zod';
import { LocalizedTextSchema, STAT_PLACEMENTS, TestimonialPlacementSchema } from './content';
import { SECTION_TYPES, type SectionType } from './sectionTypes';
import { AccentSchema, MediaRefSchema, SafeHrefSchema, VideoClipSchema } from './media';
import { SlugSchema, UuidSchema } from './primitives';

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

/**
 * The discipline cards (Round 2) — home's "Five disciplines, one studio" and the /services
 * cards. The disciplines, their counts, posters and clips come from their own tables
 * (getPublishedDisciplines); this is only the copy around them. Which of the two layouts
 * renders (home: white, links to /services#slug, the "All services" button; page: mist,
 * links to #slug) is a ROUTE decision passed as `data.mode`, never content.
 *
 * Strict since Round 2: production's home row is `{}`, and a stray key must be refused on
 * write rather than stored and ignored. `accent` is only read with an authored heading.
 */
export const ServicesOverviewSectionContentSchema = z
  .object({
    tag: Text.optional(),
    heading: Text.optional(),
    accent: AccentSchema.optional(),
    sub: Text.optional(),
    /** The line under the cards ("Open one to see every service inside it"). */
    hint: Text.optional(),
    /** The home button to /services ("All services"); page mode has none. */
    allLabel: Text.optional(),
  })
  .strict();

/** Most points the "Say hello" block lists beside its heading. */
export const HELLO_MAX_POINTS = 3;

/**
 * "Say hello" (Round 2): the inquiry block closing /services and every service page — a
 * heading, a lead line, up to three points, and the lead form (ContactForm
 * fields="hello", posted as kind=project_inquiry). The form's fields, options and
 * validation copy are code (src/lib/forms/contactPayload.ts), never content.
 */
export const HelloSectionContentSchema = z
  .object({
    tag: Text.optional(),
    heading: Text.optional(),
    /** Only read with an authored heading. */
    accent: AccentSchema.optional(),
    lead: Text.optional(),
    points: z
      .array(z.object({ text: Text }).strict())
      .max(HELLO_MAX_POINTS)
      .optional(),
  })
  .strict();

/** The token a "Start your {discipline} project" label puts the discipline's name in. */
export const EXPLORER_DISCIPLINE_TOKEN = '{discipline}';

/**
 * The /services explorer (Round 2): one panel per published discipline, each listing its
 * published services. The disciplines, services, posters and clips come from their own
 * tables (route data); this is only the two labels around them, both optional overrides of
 * the design's copy. `startLabel` must name the discipline, in both languages, through
 * `{discipline}` — a fixed label would read "Start your project" on all five panels.
 */
export const ServiceExplorerSectionContentSchema = z
  .object({
    /** The pill beside every service ("Inquire"). */
    inquireLabel: Text.optional(),
    /** The panel's closing button ("Start your {discipline} project"). */
    startLabel: Text.refine(
      (v) => v.en.includes(EXPLORER_DISCIPLINE_TOKEN) && v.ar.includes(EXPLORER_DISCIPLINE_TOKEN),
      {
        message: `Use ${EXPLORER_DISCIPLINE_TOKEN} where the discipline's name goes (both languages).`,
      },
    ).optional(),
  })
  .strict();

export const ContactSectionContentSchema = z.object({
  heading: Text.optional(),
  accent: Text.optional(),
});

/** `paper` (home, contact) or the About page's Klein band (UI v2 PR8). */
export const SOCIAL_VARIANTS = ['paper', 'klein'] as const;
export const SocialSectionContentSchema = z.object({
  variant: z.enum(SOCIAL_VARIANTS).optional(),
  tag: Text.optional(),
  heading: Text.optional(),
  /** Which heading words carry the accent (the Klein band outlines them). */
  accent: AccentSchema.optional(),
  /** The line beside the heading (Klein band only — the paper strip has none). */
  text: Text.optional(),
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

/**
 * The closing call to action (UI v2: LeadBand — the Klein band of Our Work, All projects
 * and the case study). The studio email comes from the public identity, never content.
 */
export const CtaSectionContentSchema = z.object({
  tag: Text.optional(),
  heading: Text.optional(),
  /** Which words of `heading` are outlined; only read with an authored heading. */
  accent: AccentSchema.optional(),
  text: Text.optional(),
  buttonLabel: Text.optional(),
  /** Site-relative; default the contact page's inquiry form (`/contact#inquiry`). */
  buttonHref: SafeHrefSchema.optional(),
});

/**
 * A statistics band (UI v2). The numbers come from the `statistics` table, filtered to the
 * counters shown on `placement` and labelled for that page; this is only the layout and
 * the copy around them. `cards` is the pre-UI-v2 grid (the default, so an existing
 * composition renders unchanged).
 */
export const STAT_BAND_VARIANTS = ['cards', 'band', 'reach', 'proof', 'services'] as const;

/**
 * The Services page proof band's rating line ("4.9 / 5 average client rating", Round 2).
 * `value` is shown as written, isolated LTR, so it is a short display string, not a number
 * the page could compute from anything. It is rendered as TEXT only — never as
 * AggregateRating structured data, which would assert a rating no review data backs.
 */
export const StatRatingSchema = z
  .object({
    value: z.string().trim().min(1).max(16),
    label: Text,
  })
  .strict();

export const StatisticsSectionContentSchema = z
  .object({
    variant: z.enum(STAT_BAND_VARIANTS).optional(),
    placement: z.enum(STAT_PLACEMENTS).optional(),
    tag: Text.optional(),
    heading: Text.optional(),
    accent: AccentSchema.optional(),
    text: Text.optional(),
    /** `services` only: the statement beside the numbers ("Five disciplines. One team…"). */
    line: Text.optional(),
    /** `services` only: which words of `line` carry the accent; only read with an authored line. */
    lineAccent: AccentSchema.optional(),
    /** `services` only: the rating line under the statement, with five stars. */
    rating: StatRatingSchema.optional(),
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

// ── Contact (UI v2 PR9) ──────────────────────────────────────────────────────────
// The three contact bands take copy overrides only. Strict, like the other UI v2 schemas:
// a stray key is refused on write rather than stored and silently ignored.

/**
 * The inquiry band around the lead form. `note`, `successMessage` and `submitLabel` reach
 * the form itself; the form's fields, options and validation copy are code (the fields are
 * the LeadInputSchema contract — src/lib/forms/contactPayload.ts).
 */
export const ContactInquirySectionContentSchema = z
  .object({
    tag: Text.optional(),
    heading: Text.optional(),
    accent: AccentSchema.optional(),
    lead: Text.optional(),
    /** Beside the submit button ("We read everything…"). */
    note: Text.optional(),
    /** The confirmation that replaces the fields once the server accepted the inquiry. */
    successMessage: Text.optional(),
    submitLabel: Text.optional(),
  })
  .strict();

/**
 * "Talk to us": the direct channels. The address and number are the public identity
 * (site_profile), never content — the WhatsApp card renders only when a number is set.
 */
export const ContactChannelsSectionContentSchema = z
  .object({
    tag: Text.optional(),
    heading: Text.optional(),
    accent: AccentSchema.optional(),
    lead: Text.optional(),
    emailLabel: Text.optional(),
    emailNote: Text.optional(),
    whatsappLabel: Text.optional(),
    whatsappNote: Text.optional(),
  })
  .strict();

/**
 * The FAQ band's heading only. The questions and answers stay code-owned
 * (src/lib/content/contactFaq.ts): they are also the page's FAQPage JSON-LD, and an
 * editable answer beside a fixed JSON-LD would be a structured-data mismatch.
 */
export const FaqSectionContentSchema = z
  .object({
    tag: Text.optional(),
    heading: Text.optional(),
    accent: AccentSchema.optional(),
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

/* About's "who we are" h1 enters word by word through a 16-rung CSS ladder (SplitHeading,
   `.hw--0` … `.hw--15`): past the last rung the words would pop in together, and the
   heading is the page's <h1> — so it is bounded like the hero's (words per code point,
   the same split SplitHeading uses). */
export const WHO_MAX_WORDS = 16;
export const WHO_MAX_WORD_LEN = 24;
const whoHeadingShape = (s: string): boolean => {
  const words = s.trim().split(/\s+/).filter(Boolean);
  return (
    words.length > 0 &&
    words.length <= WHO_MAX_WORDS &&
    words.every((w) => [...w].length <= WHO_MAX_WORD_LEN)
  );
};

/**
 * About "who we are" (UI v2 PR8): the page's <h1>, a media frame and the manifesto. The
 * poster is a media_assets row by id (`mediaId` — the key 0024's public-read policy looks
 * for in section content, so the image is readable exactly while this section is live);
 * with no poster the section renders text only. `clip` plays a window of a self-hosted
 * file over the poster while it is on screen (EXC-009).
 */
export const AboutWhoSectionContentSchema = z
  .object({
    tag: Text.optional(),
    heading: Text.refine((v) => whoHeadingShape(v.en) && whoHeadingShape(v.ar), {
      message: `Heading: at most ${WHO_MAX_WORDS} words, and ${WHO_MAX_WORD_LEN} characters per word (the entrance animation has ${WHO_MAX_WORDS} steps).`,
    }).optional(),
    accent: AccentSchema.optional(),
    lead: Text.optional(),
    /** Each paragraph opens with its title in bold ("Strategy before pixels."). */
    paragraphs: z
      .array(z.object({ title: Text, body: Text }))
      .max(6)
      .optional(),
    mediaId: UuidSchema.optional(),
    clip: VideoClipSchema.optional(),
  })
  // Strict: a stray key (a poster URL, say) must be refused on write, not stored and ignored.
  .strict();

/**
 * The About leadership slider (UI v2 PR8). The people are `team_members` flagged
 * `is_leadership` (getLeadership), injected by the route; this is only the copy around
 * them. Hidden when no leader is published.
 */
export const LeadershipSectionContentSchema = z
  .object({
    tag: Text.optional(),
    heading: Text.optional(),
    accent: AccentSchema.optional(),
    text: Text.optional(),
  })
  // Strict: the people come from their own table — a stray `members` key is refused.
  .strict();
// ── UI v2 PR10: Our Work (/portfolio) and All projects (/portfolio/all) ─────────────
// The projects, numbers and quotes these sections show come from their own tables; the
// content below is only the copy around them. Filter-bar chrome ("Filter by", "All
// sectors", "Clear filters"…) is built-in bilingual copy, and the facets are fixed in
// code (src/lib/portfolio/catalog.ts) — neither is content.
//
// Every schema here is strict, like the rest of UI v2: a stray key is refused on write,
// not stored and ignored. A typo (`projectslug`) would otherwise save as success and do
// nothing, and a stray `mediaId` anywhere in content would make that asset anon-readable
// under 0024's `$.**.mediaId` policy (and block its hard delete) with nothing showing it.

/**
 * The Our Work banner: a project's poster and loop under a glass caption. `projectSlug`
 * pins one project; without it (or when that project is not published) the banner shows
 * the latest (year desc, then catalogue order).
 */
export const WorkHeroSectionContentSchema = z
  .object({
    tag: Text.optional(),
    projectSlug: SlugSchema.optional(),
  })
  .strict();

/** Most quotes the proof carousel shows (the loader's own cap is 8). */
export const PROOF_QUOTES_MAX = 8;

/**
 * Our Work's white proof band: the page's statistics (placement `work`) above its
 * testimonials. Each half hides on its own when it has nothing to show; with neither,
 * the section renders nothing.
 */
export const ProofSectionContentSchema = z
  .object({
    statsTag: Text.optional(),
    quotesTag: Text.optional(),
    quotesHeading: Text.optional(),
    /** Only read with an authored quotesHeading. */
    quotesAccent: AccentSchema.optional(),
    quotesLimit: z.number().int().min(1).max(PROOF_QUOTES_MAX).optional(),
    /** Opt-OUT of the count-up (server-rendered final values either way). */
    staticNumbers: z.boolean().optional(),
    minItems: z.number().int().min(1).max(6).optional(),
  })
  .strict();

/** One of the intro's two frames: a media library image, optionally looping a clip. */
export const WorkIntroMediaSchema = MediaRefSchema.extend({
  clip: VideoClipSchema.optional(),
}).strict();

/**
 * The intro statement between two looping frames. `media` is keyed `mediaId` on purpose:
 * the 0024 anon read policy and media_usage() find section media by that key
 * (`$.**.mediaId`), so an image referenced any other way would never reach a visitor.
 */
export const WorkIntroSectionContentSchema = z
  .object({
    text: Text.optional(),
    linkLabel: Text.optional(),
    media: z.array(WorkIntroMediaSchema).max(2).optional(),
  })
  .strict();

/** The featured-projects grid with its filter bar (the pool is `is_featured`). */
export const ProjectGridSectionContentSchema = z
  .object({
    tag: Text.optional(),
    heading: Text.optional(),
  })
  .strict();

/**
 * A page head on black: a back link, the h1 with an accented word range, a lead line and
 * (on the catalogue) the live project count, which the route supplies.
 */
export const PageHeadSectionContentSchema = z
  .object({
    heading: Text.optional(),
    /** Only read with an authored heading. */
    accent: AccentSchema.optional(),
    lead: Text.optional(),
    backLabel: Text.optional(),
    backHref: SafeHrefSchema.optional(),
  })
  .strict();

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
  aboutWho: AboutWhoSectionContentSchema,
  leadership: LeadershipSectionContentSchema,
  // UI v2 PR10 (projectCatalog takes no content: its data is the portfolio table)
  workHero: WorkHeroSectionContentSchema,
  proof: ProofSectionContentSchema,
  workIntro: WorkIntroSectionContentSchema,
  projectGrid: ProjectGridSectionContentSchema,
  pageHead: PageHeadSectionContentSchema,
  // UI v2 PR9 (contact)
  contactInquiry: ContactInquirySectionContentSchema,
  contactChannels: ContactChannelsSectionContentSchema,
  faq: FaqSectionContentSchema,
  // Round 2 (services)
  hello: HelloSectionContentSchema,
  serviceExplorer: ServiceExplorerSectionContentSchema,
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
export type AboutWhoSectionContent = z.infer<typeof AboutWhoSectionContentSchema>;
export type LeadershipSectionContent = z.infer<typeof LeadershipSectionContentSchema>;
export type WorkHeroSectionContent = z.infer<typeof WorkHeroSectionContentSchema>;
export type ProofSectionContent = z.infer<typeof ProofSectionContentSchema>;
export type WorkIntroSectionContent = z.infer<typeof WorkIntroSectionContentSchema>;
export type ProjectGridSectionContent = z.infer<typeof ProjectGridSectionContentSchema>;
export type PageHeadSectionContent = z.infer<typeof PageHeadSectionContentSchema>;
export type ContactInquirySectionContent = z.infer<typeof ContactInquirySectionContentSchema>;
export type ContactChannelsSectionContent = z.infer<typeof ContactChannelsSectionContentSchema>;
export type FaqSectionContent = z.infer<typeof FaqSectionContentSchema>;
export type HelloSectionContent = z.infer<typeof HelloSectionContentSchema>;
export type ServiceExplorerSectionContent = z.infer<typeof ServiceExplorerSectionContentSchema>;
export type StatisticsSectionContent = z.infer<typeof StatisticsSectionContentSchema>;
export type StatRating = z.infer<typeof StatRatingSchema>;
