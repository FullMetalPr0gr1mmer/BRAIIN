import { z } from 'zod';
import {
  BilingualTextSchema,
  ContentStatusSchema,
  LocaleSchema,
  SlugSchema,
  UuidSchema,
} from './primitives';
import { LocalizedProseSchema } from './content';
import { LocalizedDocSchema } from './tiptap';

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

export const PortfolioWriteSchema = z.object({
  slug: SlugSchema,
  title: BilingualTextSchema,
  summary: LocalizedProseSchema.nullish(),
  body: LocalizedDocSchema.nullish(),
  status: ContentStatusSchema.default('draft'),
  sortOrder: SortOrderSchema,
  scheduledFor: InstantSchema,
  /** Services this case study belongs to (`portfolio_services`). */
  serviceIds: z.array(UuidSchema).max(20).optional(),
});
export const PortfolioUpdateSchema = updatable(PortfolioWriteSchema);
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

export const SectionWriteSchema = z.object({
  pageId: UuidSchema,
  type: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-zA-Z][a-zA-Z0-9]*$/, 'must be a component-style identifier'),
  content: SectionPayloadSchema.default({}),
  style: SectionPayloadSchema.default({}),
  visible: z.boolean().default(true),
  sortOrder: SortOrderSchema,
});
export const SectionUpdateSchema = updatable(SectionWriteSchema);

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

export const TeamMemberWriteSchema = z.object({
  slug: SlugSchema,
  name: BilingualTextSchema,
  bio: LocalizedProseSchema.nullish(),
  avatarUrl: UrlFieldSchema.nullish(),
  profileUserId: UuidSchema.nullish(),
  status: ContentStatusSchema.default('draft'),
  sortOrder: SortOrderSchema,
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

export const StatisticWriteSchema = z.object({
  slug: SlugSchema,
  label: BilingualTextSchema,
  /** Display string so authored suffixes ('+', '%', 'x') survive verbatim. */
  value: z.string().trim().min(1).max(40),
  status: ContentStatusSchema.default('draft'),
  sortOrder: SortOrderSchema,
});
export const StatisticUpdateSchema = updatable(StatisticWriteSchema);

export const PartnerLogoWriteSchema = z.object({
  name: ShortTextSchema,
  logoUrl: UrlFieldSchema,
  scale: z.number().min(0.1).max(5).default(1),
  offsetY: z.number().min(-200).max(200).default(0),
  visible: z.boolean().default(true),
  sortOrder: SortOrderSchema,
});
export const PartnerLogoUpdateSchema = updatable(PartnerLogoWriteSchema);

// ── Navigation ──────────────────────────────────────────────────────────────────

export const NavItemWriteSchema = z.object({
  location: z.enum(['header', 'footer']),
  parentId: UuidSchema.nullish(),
  label: BilingualTextSchema,
  /** Site-relative or absolute; same scheme allowlist as rich-text links. */
  href: z.string().trim().min(1).max(2048),
  visible: z.boolean().default(true),
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

export const MediaWriteSchema = z.object({
  kind: z.enum(['image', 'video', 'audio', 'pdf']),
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
export const MediaUpdateSchema = updatable(MediaWriteSchema);

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
