import { z } from 'zod';
import {
  BilingualTextSchema,
  ContentStatusSchema,
  LocaleSchema,
  SlugSchema,
  UuidSchema,
} from './primitives';
import {
  BREAKDOWN_KINDS,
  LocalizedProseSchema,
  MEDIA_LAYOUTS,
  PORTFOLIO_MEDIA_ROLES,
  ResultCardSchema,
  STAT_PLACEMENTS,
  TESTIMONIAL_PLACEMENTS,
} from './content';
import { LocalizedDocSchema } from './tiptap';
import { SectionTypeSchema, sectionContentIssues, type SectionType } from './sections';
import { StaticMediaKeySchema, VideoClipSchema } from './media';

// Every admin write goes through a schema in this file. CLAUDE.md §8: "Zod is the
// single content boundary."
//
// Two conventions worth stating once, since they repeat ~20 times below:
//
// 1. UPDATE schemas are `.partial()` plus a REQUIRED `version`. Partial because a CMS
//    form should be able to save one field without resubmitting (and silently
//    overwriting) every other one; required version because an update with no
//    optimistic-lock token is exactly the last-write-wins bug CLAUDE.md Pillar 4 spends
//    a column to prevent — making it non-optional means the type system refuses to
//    express the unsafe call.
//
// 2. Inputs are camelCase and map to snake_case columns in `src/lib/admin/*`. The wire
//    format is deliberately not the table shape: it keeps a column rename from becoming
//    a breaking API change, and it means a client cannot reach a column simply by
//    guessing its name — anything not listed here is dropped before the query is built.

// ── Shared ──────────────────────────────────────────────────────────────────────

/** Query string for every list endpoint. Coerced because query params are strings. */
export const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  status: ContentStatusSchema.optional(),
  q: z.string().max(120).optional(),
});
export type ListQuery = z.infer<typeof ListQuerySchema>;

export const IdSchema = z.object({ id: UuidSchema });

/** ISO-8601 instant or null. */
const InstantSchema = z.string().datetime({ offset: true }).nullish();

const VersionSchema = z.number().int().min(1);

/** `.partial()` + required version — see convention (1) above. */
function updatable<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  return schema.partial().extend({ version: VersionSchema });
}

const SortOrderSchema = z.number().int().min(-10_000).max(10_000).default(0);

/** Short free text that ends up in HTML attributes or headings. */
const ShortTextSchema = z.string().trim().min(1).max(200);
const UrlFieldSchema = z.string().trim().max(2048);

// ── Auth ────────────────────────────────────────────────────────────────────────

export const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  // Only a floor + ceiling: the real policy lives in GoTrue. The ceiling matters
  // because bcrypt-family hashing is CPU-bound in the password length, which makes an
  // unbounded field a cheap denial-of-service against the auth server.
  password: z.string().min(8).max(256),
});
export type LoginInput = z.infer<typeof LoginSchema>;

// ── Services ────────────────────────────────────────────────────────────────────

export const ServiceWriteSchema = z.object({
  slug: SlugSchema,
  title: BilingualTextSchema,
  blurb: LocalizedProseSchema.nullish(),
  body: LocalizedDocSchema.nullish(),
  heroVideoUid: z.string().trim().max(120).nullish(),
  category: z.string().trim().max(80).nullish(),
  /** Chip/skill label where it differs from the title (e.g. SEO / GEO / AEO). */
  shortTitle: BilingualTextSchema.nullish(),
  status: ContentStatusSchema.default('draft'),
  isTeaser: z.boolean().default(false),
  sortOrder: SortOrderSchema,
  scheduledFor: InstantSchema,
});
export const ServiceUpdateSchema = updatable(ServiceWriteSchema);
export type ServiceWrite = z.infer<typeof ServiceWriteSchema>;
export type ServiceUpdate = z.infer<typeof ServiceUpdateSchema>;

// ── Blog ────────────────────────────────────────────────────────────────────────

export const PostWriteSchema = z.object({
  slug: SlugSchema,
  title: BilingualTextSchema,
  excerpt: LocalizedProseSchema.nullish(),
  body: LocalizedDocSchema.nullish(),
  // Required at publish time by `assertPublishable` — E-E-A-T forbids anonymous
  // authorship (CLAUDE.md Pillar 3), but a draft is allowed to not know its author yet.
  authorId: UuidSchema.nullish(),
  categoryId: UuidSchema.nullish(),
  coverImageUrl: UrlFieldSchema.nullish(),
  status: ContentStatusSchema.default('draft'),
  scheduledFor: InstantSchema,
});
export const PostUpdateSchema = updatable(PostWriteSchema);
export type PostWrite = z.infer<typeof PostWriteSchema>;

// ── Portfolio ───────────────────────────────────────────────────────────────────

/** `/portfolio/all` is the catalogue route — a project may never be called "all" (0022). */
const PortfolioSlugSchema = SlugSchema.refine((s) => s !== 'all', {
  message: '"all" is reserved for the All projects page',
});

/** One item of a case study's media set (`portfolio_media`) — mirrors the 0022 CHECKs. */
export const PortfolioMediaItemSchema = z
  .object({
    role: z.enum(PORTFOLIO_MEDIA_ROLES),
    kind: z.enum(['image', 'video']),
    /** The image — or, for a video, its poster. */
    mediaId: UuidSchema.nullish(),
    clip: VideoClipSchema.nullish(),
    /** "1:30" — shown on the final film. */
    durationLabel: z
      .string()
      .regex(/^[0-9]{1,2}:[0-5][0-9]$/, 'm:ss')
      .nullish(),
    caption: BilingualTextSchema.nullish(),
    breakdownKind: z.enum(BREAKDOWN_KINDS).nullish(),
    layout: z.enum(MEDIA_LAYOUTS).nullish(),
  })
  .superRefine((v, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if ((v.role === 'breakdown') !== Boolean(v.breakdownKind)) {
      issue('breakdownKind', 'a breakdown item has a kind (sketch / bts / process); others none');
    }
    if (v.kind === 'image') {
      if (!v.mediaId) issue('mediaId', 'choose the image');
      if (v.clip) issue('clip', 'an image item has no video');
    } else if (!v.clip) {
      issue('clip', 'a video item needs its video');
    }
  });
export type PortfolioMediaItem = z.infer<typeof PortfolioMediaItemSchema>;

const PortfolioWriteBase = z.object({
  slug: PortfolioSlugSchema,
  title: BilingualTextSchema,
  summary: LocalizedProseSchema.nullish(),
  body: LocalizedDocSchema.nullish(),
  status: ContentStatusSchema.default('draft'),
  sortOrder: SortOrderSchema,
  scheduledFor: InstantSchema,
  /** Services this case study belongs to (`portfolio_services`), in display order. */
  serviceIds: z.array(UuidSchema).max(20).optional(),
  // Catalogue (UI v2)
  projectType: BilingualTextSchema.nullish(),
  /** The card blurb; the loader falls back to `summary`. */
  teaser: BilingualTextSchema.nullish(),
  sectorId: UuidSchema.nullish(),
  clientId: UuidSchema.nullish(),
  year: z.number().int().min(2000).max(2100).nullish(),
  isFeatured: z.boolean().default(false),
  posterMediaId: UuidSchema.nullish(),
  /** The card's hover loop — maps to preview_video_uid/path + window (EXC-009). */
  preview: VideoClipSchema.nullish(),
  // Case study
  lead: BilingualTextSchema.nullish(),
  goal: BilingualTextSchema.nullish(),
  result: BilingualTextSchema.nullish(),
  scope: z.array(BilingualTextSchema).max(10).default([]),
  keywords: z.array(BilingualTextSchema).max(6).default([]),
  results: z.array(ResultCardSchema).max(4).default([]),
  /** Explicit "next project"; empty = the next one in catalogue order. */
  nextPortfolioId: UuidSchema.nullish(),
  /** The complete ordered media set, saved with the project in one transaction. */
  media: z.array(PortfolioMediaItemSchema).max(40).optional(),
  /** Design-delivery placeholder: the 0025 production guard refuses to publish it. */
  isPlaceholder: z.boolean().default(false),
});

/** One hero and one final film at most (the 0022 partial unique indexes). */
function checkPortfolioMedia(
  v: { media?: PortfolioMediaItem[] | undefined },
  ctx: z.RefinementCtx,
): void {
  for (const role of ['hero', 'final'] as const) {
    if ((v.media ?? []).filter((m) => m.role === role).length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['media'],
        message: `a case study has at most one ${role} item`,
      });
    }
  }
}

export const PortfolioWriteSchema = PortfolioWriteBase.superRefine(checkPortfolioMedia);
export const PortfolioUpdateSchema = updatable(PortfolioWriteBase).superRefine(checkPortfolioMedia);
export type PortfolioWrite = z.infer<typeof PortfolioWriteSchema>;

// ── Pages & sections ────────────────────────────────────────────────────────────

export const PageWriteSchema = z.object({
  slug: SlugSchema,
  title: BilingualTextSchema,
  status: ContentStatusSchema.default('draft'),
  navVisible: z.boolean().default(true),
  scheduledFor: InstantSchema,
});
export const PageUpdateSchema = updatable(PageWriteSchema);

/**
 * Section `content` and `style` stay open-shaped (`Record<string, unknown>`) because
 * each section TYPE defines its own payload and the renderer validates per-type. The
 * ceiling is what matters at this boundary — a 256 KB JSONB blob per section is a
 * storage-amplification vector regardless of shape.
 */
const SectionPayloadSchema = z
  .record(z.string(), z.unknown())
  .refine((v) => JSON.stringify(v).length <= 65_536, { message: 'section payload exceeds 64 KB' });

// `type` is the SECTION_TYPES enum, not a free identifier: an unknown type used to save
// fine and then be skipped by the renderer without a word — the editor saw "saved", the
// visitor saw nothing. `content` is validated against its type's schema on write (the
// loader still re-validates on read, so a row written around the API degrades rather
// than breaks). `style` is gone from the write surface: nothing ever read it, and under a
// nonce CSP with no 'unsafe-inline' it could not be applied anyway (the column stays).
const SectionWriteBase = z.object({
  pageId: UuidSchema,
  type: SectionTypeSchema,
  content: SectionPayloadSchema.default({}),
  visible: z.boolean().default(true),
  sortOrder: SortOrderSchema,
  /** Design-delivery placeholder (0016). The 0025 production guard refuses to show one. */
  isPlaceholder: z.boolean().default(false),
});

function checkSectionContent(
  v: { type?: SectionType | undefined; content?: Record<string, unknown> | undefined },
  ctx: z.RefinementCtx,
): void {
  // An update that changes content without restating `type` (or type without content) is
  // validated against the row it will produce by sectionResource.assertWritable
  // (src/lib/admin/resources.ts); here we check what the payload alone can prove.
  if (v.type === undefined || v.content === undefined) return;
  for (const issue of sectionContentIssues(v.type, v.content)) ctx.addIssue(issue);
}

export const SectionWriteSchema = SectionWriteBase.superRefine(checkSectionContent);
export const SectionUpdateSchema = updatable(SectionWriteBase).superRefine(checkSectionContent);

/** Bulk reorder — one round-trip instead of N optimistic updates that can half-apply. */
export const ReorderSchema = z.object({
  items: z
    .array(z.object({ id: UuidSchema, sortOrder: z.number().int() }))
    .min(1)
    .max(200),
});
export type ReorderInput = z.infer<typeof ReorderSchema>;

// ── Categories · team · certifications · statistics · partner logos ─────────────

export const CategoryWriteSchema = z.object({
  slug: SlugSchema,
  name: BilingualTextSchema,
});
export const CategoryUpdateSchema = updatable(CategoryWriteSchema);

/** The same shape 0023 CHECKs: a personal or company LinkedIn page, https only. */
const LinkedInUrlSchema = z
  .string()
  .trim()
  .regex(
    /^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/(in|company)\/[A-Za-z0-9_-]+\/?$/,
    'a https://linkedin.com/in/… or /company/… URL',
  );

export const TeamMemberWriteSchema = z.object({
  slug: SlugSchema,
  name: BilingualTextSchema,
  bio: LocalizedProseSchema.nullish(),
  avatarUrl: UrlFieldSchema.nullish(),
  profileUserId: UuidSchema.nullish(),
  status: ContentStatusSchema.default('draft'),
  sortOrder: SortOrderSchema,
  /** Job title on the About leadership slider. */
  role: BilingualTextSchema.nullish(),
  linkedinUrl: LinkedInUrlSchema.nullish(),
  isLeadership: z.boolean().default(false),
  portraitMediaId: UuidSchema.nullish(),
  isPlaceholder: z.boolean().default(false),
});
export const TeamMemberUpdateSchema = updatable(TeamMemberWriteSchema);

export const CertificationWriteSchema = z.object({
  slug: SlugSchema,
  name: BilingualTextSchema,
  issuer: LocalizedProseSchema.nullish(),
  year: z.number().int().min(1900).max(2200).nullish(),
  logoUrl: UrlFieldSchema.nullish(),
  status: ContentStatusSchema.default('draft'),
  sortOrder: SortOrderSchema,
});
export const CertificationUpdateSchema = updatable(CertificationWriteSchema);

const StatPlacement = z.enum(STAT_PLACEMENTS);

/**
 * Per-page labels, keyed by page ({about: {en, ar}}). The admin form edits them as a list
 * of {placement, label} rows; both shapes are accepted and the list is folded into the
 * object here (a page listed twice keeps its last label).
 */
const PlacementLabelsSchema = z.preprocess(
  (v) =>
    Array.isArray(v)
      ? Object.fromEntries(
          v
            .filter((i): i is Record<string, unknown> => i !== null && typeof i === 'object')
            .map((i) => [i['placement'], i['label']]),
        )
      : v,
  z.record(StatPlacement, BilingualTextSchema),
);

const StatisticWriteBase = z.object({
  slug: SlugSchema,
  label: BilingualTextSchema,
  /**
   * Display string so authored suffixes ('+', '%', 'x') survive verbatim. Optional when
   * `valueNumeric` is given: the resource derives it (number + suffix), which is the only
   * way the 0023 statistics_value_consistent CHECK can hold.
   */
  value: z.string().trim().min(1).max(40).nullish(),
  valueNumeric: z.number().min(0).max(9_999_999_999.99).nullish(),
  valueSuffix: z.string().trim().max(4).nullish(),
  /** Pages this counter appears on. */
  placements: z
    .array(StatPlacement)
    .max(STAT_PLACEMENTS.length)
    .refine((a) => new Set(a).size === a.length, { message: 'each page once' })
    .default([]),
  /** Per-page label where it differs from `label` ({about: {en, ar}}). */
  placementLabels: PlacementLabelsSchema.default({}),
  status: ContentStatusSchema.default('draft'),
  sortOrder: SortOrderSchema,
  isPlaceholder: z.boolean().default(false),
});

const hasNumber = (v: { valueNumeric?: number | null | undefined }) =>
  typeof v.valueNumeric === 'number';

export const StatisticWriteSchema = StatisticWriteBase.refine(
  (v) => (typeof v.value === 'string' && v.value !== '') || hasNumber(v),
  { path: ['value'], message: 'give the value (or a number to count up to)' },
);
export const StatisticUpdateSchema = updatable(StatisticWriteBase)
  // The displayed value is derived from number + suffix, so they travel together — a
  // suffix alone cannot be combined with a stored number the request cannot see.
  .refine((v) => v.valueSuffix === undefined || v.valueNumeric !== undefined, {
    path: ['valueNumeric'],
    message: 'send the number together with its suffix',
  })
  .refine((v) => v.value !== null || hasNumber(v), {
    path: ['value'],
    message: 'give the value (or a number to count up to)',
  });

export const PartnerLogoWriteSchema = z.object({
  name: ShortTextSchema,
  logoUrl: UrlFieldSchema,
  scale: z.number().min(0.1).max(5).default(1),
  offsetY: z.number().min(-200).max(200).default(0),
  visible: z.boolean().default(true),
  sortOrder: SortOrderSchema,
});
export const PartnerLogoUpdateSchema = updatable(PartnerLogoWriteSchema);

// ── Sectors · clients · testimonials (UI v2, 0021) ──────────────────────────────

export const SectorWriteSchema = z.object({
  slug: SlugSchema,
  name: BilingualTextSchema,
  visible: z.boolean().default(true),
  sortOrder: SortOrderSchema,
});
export const SectorUpdateSchema = updatable(SectorWriteSchema);

export const ClientWriteSchema = z.object({
  slug: SlugSchema,
  name: BilingualTextSchema,
  logoMediaId: UuidSchema.nullish(),
  websiteUrl: z.string().trim().url().startsWith('https://').max(300).nullish(),
  showInMarquee: z.boolean().default(false),
  /**
   * The public-disclosure permission: a client appears on the site only once someone has
   * confirmed we may name them. Default hidden (fail-closed).
   */
  visible: z.boolean().default(false),
  isPlaceholder: z.boolean().default(false),
  sortOrder: SortOrderSchema,
});
export const ClientUpdateSchema = updatable(ClientWriteSchema);

const TestimonialWriteBase = z.object({
  slug: SlugSchema,
  quote: z.object({ en: z.string().trim().min(1).max(600), ar: z.string().trim().min(1).max(600) }),
  authorName: BilingualTextSchema,
  /** "Title, Company" verbatim — there is no company column. */
  authorRole: BilingualTextSchema.nullish(),
  clientId: UuidSchema.nullish(),
  /** Shown on this case study (at most one published quote per project). */
  portfolioId: UuidSchema.nullish(),
  avatarMediaId: UuidSchema.nullish(),
  placements: z
    .array(z.enum(TESTIMONIAL_PLACEMENTS))
    .max(TESTIMONIAL_PLACEMENTS.length)
    .refine((a) => new Set(a).size === a.length, { message: 'each page once' })
    .default([]),
  /** When the person agreed to be quoted — required to publish or schedule (DB CHECK). */
  consentObtainedAt: InstantSchema,
  /** Where that consent is recorded (a ticket or document id) — never shown publicly. */
  consentReference: z.string().trim().max(200).nullish(),
  status: ContentStatusSchema.default('draft'),
  scheduledFor: InstantSchema,
  sortOrder: SortOrderSchema,
  isPlaceholder: z.boolean().default(false),
});

/** Create: a live quote states its consent. The 0021 CHECK holds every row to the same rule. */
function checkConsent(
  v: { status?: string | undefined; consentObtainedAt?: string | null | undefined },
  ctx: z.RefinementCtx,
): void {
  if ((v.status === 'published' || v.status === 'scheduled') && !v.consentObtainedAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['consentObtainedAt'],
      message: 'record when consent was obtained before publishing a quote',
    });
  }
}

export const TestimonialWriteSchema = TestimonialWriteBase.superRefine(checkConsent);
export const TestimonialUpdateSchema = updatable(TestimonialWriteBase).superRefine((v, ctx) => {
  // On update only an explicit null clears consent; an omitted key keeps the stored value.
  if ((v.status === 'published' || v.status === 'scheduled') && v.consentObtainedAt === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['consentObtainedAt'],
      message: 'a published or scheduled quote needs its consent date',
    });
  }
});

// ── Navigation ──────────────────────────────────────────────────────────────────

export const NavItemWriteSchema = z.object({
  location: z.enum(['header', 'footer']),
  parentId: UuidSchema.nullish(),
  label: BilingualTextSchema,
  /** Site-relative or absolute; same scheme allowlist as rich-text links. */
  href: z.string().trim().min(1).max(2048),
  visible: z.boolean().default(true),
  /** The link the header keeps visible at <=900px. At most one per location (0019 index). */
  isKey: z.boolean().default(false),
  sortOrder: SortOrderSchema,
});
export const NavItemUpdateSchema = updatable(NavItemWriteSchema);

// ── SEO ─────────────────────────────────────────────────────────────────────────

/**
 * AR is REQUIRED on both meta fields. CLAUDE.md Pillar 3 makes Arabic metadata
 * first-class and CI blocks empty `meta_*_ar`; enforcing it at the write boundary is
 * what stops the CI gate from being the first place anyone finds out.
 */
export const EntitySeoWriteSchema = z.object({
  entityType: z.enum(['service', 'blog_post', 'portfolio', 'page']),
  entityId: UuidSchema,
  metaTitle: BilingualTextSchema,
  metaDescription: BilingualTextSchema,
  ogImage: UrlFieldSchema.nullish(),
  canonicalOverride: UrlFieldSchema.nullish(),
  robots: z.string().trim().max(120).nullish(),
  schemaType: z.string().trim().max(60).nullish(),
});
export const EntitySeoUpdateSchema = updatable(EntitySeoWriteSchema);

export const SeoDefaultsSchema = z.object({
  titleTemplate: BilingualTextSchema.partial().optional(),
  defaultTitle: BilingualTextSchema.partial().optional(),
  defaultDescription: BilingualTextSchema.partial().optional(),
  defaultOgImage: UrlFieldSchema.nullish(),
  organization: z.record(z.string(), z.unknown()).optional(),
  robotsDirectives: z.string().trim().max(120).optional(),
  version: VersionSchema,
});

export const RedirectWriteSchema = z.object({
  sourcePath: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .regex(/^\//, 'must be a site-relative path starting with /'),
  targetPath: z.string().trim().min(1).max(2048),
  status: z.union([z.literal(301), z.literal(302), z.literal(308)]).default(301),
});
export const RedirectUpdateSchema = updatable(RedirectWriteSchema);

// ── Media ───────────────────────────────────────────────────────────────────────

export const MEDIA_PROVIDERS = ['external', 'static', 'cf_images', 'stream'] as const;

const MediaWriteBase = z.object({
  kind: z.enum(['image', 'video', 'audio', 'pdf']),
  /**
   * Where the bytes live (0020): `static` = a still shipped with the site (storagePath is
   * a registry key, checked against src/lib/media/static.ts by the media resource);
   * `cf_images` = uploaded through the admin (PR5); `stream` = a Stream video.
   */
  provider: z.enum(MEDIA_PROVIDERS).default('external'),
  storagePath: z.string().trim().min(1).max(1024),
  folder: z.string().trim().max(200).nullish(),
  /** Alt text is bilingual and REQUIRED for images — WCAG 2.2 AA is a DoD gate. */
  alt: BilingualTextSchema.nullish(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  width: z.number().int().min(1).max(20_000).nullish(),
  height: z.number().int().min(1).max(20_000).nullish(),
  mimeType: z.string().trim().max(120).nullish(),
  sizeBytes: z.number().int().min(0).nullish(),
  streamUid: z.string().trim().max(120).nullish(),
});

/** The provider's shape — the 0020 media_assets_provider_shape CHECK, stated up front. */
function checkProvider(
  v: { provider?: string | undefined; storagePath?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (v.provider === 'static' && v.storagePath !== undefined) {
    if (!StaticMediaKeySchema.safeParse(v.storagePath).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['storagePath'],
        message: 'a static asset is a stills/… key from the build-time registry',
      });
    }
  }
  if (v.provider === 'cf_images') {
    // Rows of this provider are created only by the upload endpoint (PR5), never typed in.
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['provider'],
      message: 'Cloudflare Images assets are created by uploading, not by hand',
    });
  }
}

export const MediaWriteSchema = MediaWriteBase.superRefine(checkProvider);
export const MediaUpdateSchema = updatable(MediaWriteBase).superRefine(checkProvider);

/** SEO holds `media.write: 'meta'` — metadata only, never the binary or its path. */
export const MediaMetaOnlySchema = z.object({
  alt: BilingualTextSchema.nullish(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  folder: z.string().trim().max(200).nullish(),
  version: VersionSchema,
});

// ── Leads ───────────────────────────────────────────────────────────────────────

export const LeadStatusSchema = z.enum(['new', 'in_progress', 'done', 'spam']);

export const LeadUpdateSchema = z.object({
  status: LeadStatusSchema.optional(),
  internalNotes: z.string().max(5000).nullish(),
});

export const LeadListQuerySchema = ListQuerySchema.extend({
  status: LeadStatusSchema.optional(),
});

export const ExportQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  status: LeadStatusSchema.optional(),
});

// ── Settings · integrations · theme · users ─────────────────────────────────────

export const SiteSettingsSchema = z.object({
  identity: z.record(z.string(), z.unknown()).optional(),
  retention: z
    .object({
      // Bounded, not free-form: retention is a PDPL commitment, and Pillar 4 pins raw
      // telemetry at 90 days "pending legal sign-off (may go shorter, never longer)".
      // The ceiling is that promise expressed as a constraint.
      raw_telemetry_days: z.number().int().min(1).max(90).optional(),
      leads_months: z.number().int().min(1).max(24).optional(),
      spam_days: z.number().int().min(1).max(90).optional(),
    })
    .optional(),
  version: VersionSchema,
});

export const MaintenanceSchema = z.object({
  active: z.boolean(),
  /** IPv4/IPv6 literals only — a hostname here would need DNS at request time. */
  allowlist: z
    .array(z.union([z.string().ip({ version: 'v4' }), z.string().ip({ version: 'v6' })]))
    .max(50)
    .default([]),
  version: VersionSchema,
});

export const IntegrationsSchema = z.object({
  ga4: z.record(z.string(), z.unknown()).optional(),
  searchConsole: z.record(z.string(), z.unknown()).optional(),
  calendly: z.record(z.string(), z.unknown()).optional(),
  recaptcha: z.record(z.string(), z.unknown()).optional(),
  version: VersionSchema,
});

/**
 * Theme tokens are CSS CUSTOM PROPERTIES ONLY (CLAUDE.md §7). The key pattern and the
 * value pattern together are the CSP story: with no `'unsafe-inline'` in `style-src`,
 * a token is injected as `--name: value` inside one nonced <style> block, so a value
 * containing `;` or `}` would break out of the declaration and author arbitrary CSS.
 */
export const ThemeTokensSchema = z.record(
  z.string().regex(/^--[a-z0-9-]{1,60}$/, 'token names must be CSS custom properties'),
  z
    .string()
    .max(120)
    .regex(/^[^;{}<>\\]*$/, 'token values may not contain ; { } < > or backslash'),
);

export const ThemeWriteSchema = z.object({
  name: ShortTextSchema,
  tokens: ThemeTokensSchema.default({}),
  isActive: z.boolean().default(false),
});
export const ThemeUpdateSchema = updatable(ThemeWriteSchema);

export const RoleSchema = z.enum(['admin', 'content_creator', 'seo', 'developer']);

export const UserInviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  role: RoleSchema,
  displayName: z.string().trim().max(120).optional(),
});

export const UserUpdateSchema = z.object({
  userId: UuidSchema,
  role: RoleSchema.optional(),
  isActive: z.boolean().optional(),
  displayName: z.string().trim().max(120).nullish(),
});

// ── AI Style-Finder authoring ───────────────────────────────────────────────────

export const AiQuestionWriteSchema = z.object({
  slug: SlugSchema,
  prompt: BilingualTextSchema,
  helpText: LocalizedProseSchema.nullish(),
  inputType: z.enum(['single', 'multi', 'scale', 'text']).default('single'),
  options: z
    .array(z.object({ value: z.string().trim().min(1).max(60), label: BilingualTextSchema }))
    .max(20)
    .default([]),
  status: ContentStatusSchema.default('draft'),
  sortOrder: SortOrderSchema,
});
export const AiQuestionUpdateSchema = updatable(AiQuestionWriteSchema);

export const AiStyleWriteSchema = z.object({
  slug: SlugSchema,
  name: BilingualTextSchema,
  description: LocalizedProseSchema.nullish(),
  traits: z.record(z.string().max(60), z.number().min(0).max(1)).default({}),
  imageUrl: UrlFieldSchema.nullish(),
  status: ContentStatusSchema.default('draft'),
  sortOrder: SortOrderSchema,
});
export const AiStyleUpdateSchema = updatable(AiStyleWriteSchema);

export const AiConfigSchema = z.object({
  enabled: z.boolean().optional(),
  model: z.string().trim().max(80).optional(),
  // Ceilings, not just types. The spend cap is the last line of defence against a
  // runaway prompt loop, so "someone typed an extra zero in the admin" must not be able
  // to raise it past what the tenant can absorb (CLAUDE.md Pillar 1).
  dailyUsdCap: z.number().min(0).max(1000).optional(),
  perIpHourlyLimit: z.number().int().min(1).max(1000).optional(),
  perSessionHourlyLimit: z.number().int().min(1).max(1000).optional(),
  systemPrompt: z.string().max(8000).nullish(),
  scoring: z.record(z.string(), z.unknown()).optional(),
  version: VersionSchema,
});

// ── Analytics / logs queries ────────────────────────────────────────────────────

export const AnalyticsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(28),
  locale: LocaleSchema.optional(),
});

export const LogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
});
