import { z } from 'zod';
import { hasControlChars } from './search';

// Site-wide releases (Admin v2 track REL, docs/admin-v2/releases.md). The closed
// vocabularies of the release ledger, migration 0038 (R1), and the shapes the release
// endpoints accept (R6 onward). The SQL CHECKs and the app.release_entities rows carry the
// same lists; tests/schemas/release.spec.ts parses the migration and compares.
//
// Nothing imports this yet: the ledger is inert until the slices that use it (R2 to R14).

/** Every entity type a release may change: one row each in app.release_entities. */
export const RELEASE_ENTITY_TYPES = [
  'category',
  'sector',
  'client',
  'team_member',
  'statistic',
  'certification',
  'discipline',
  'service',
  'portfolio',
  'service_case',
  'testimonial',
  'blog_post',
  'page',
  'page_section',
  'nav_item',
  'site_profile',
  'custom_theme',
  'entity_seo',
  'seo_defaults',
  'redirect',
] as const;
export type ReleaseEntityType = (typeof RELEASE_ENTITY_TYPES)[number];
export const ReleaseEntityTypeSchema = z.enum(RELEASE_ENTITY_TYPES);

/** The groups the savebar and the publish dialog count by ("2 in Pages · 1 in SEO"). */
export const RELEASE_AREAS = [
  'pages',
  'services',
  'our_work',
  'collections',
  'blog',
  'navigation',
  'settings',
  'appearance',
  'seo',
] as const;
export type ReleaseArea = (typeof RELEASE_AREAS)[number];
export const ReleaseAreaSchema = z.enum(RELEASE_AREAS);

/** What a pending change does to its entity. */
export const DRAFT_OPS = ['create', 'update', 'delete'] as const;
export type DraftOp = (typeof DRAFT_OPS)[number];
export const DraftOpSchema = z.enum(DRAFT_OPS);

/** How a site version came to be: the switch-on baseline, a publish, a restore, or a
 *  scheduled row converted at switch-on. */
export const RELEASE_KINDS = ['baseline', 'publish', 'rollback', 'legacy_schedule'] as const;
export type ReleaseKind = (typeof RELEASE_KINDS)[number];
export const ReleaseKindSchema = z.enum(RELEASE_KINDS);

export const RELEASE_STATUSES = [
  'applying',
  'scheduled',
  'published',
  'failed',
  'cancelled',
] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];
export const ReleaseStatusSchema = z.enum(RELEASE_STATUSES);

/** Where the cache purge of a published release stands (releases.md §5.3). */
export const PURGE_STATUSES = ['pending', 'done', 'skipped', 'failed', 'not_needed'] as const;
export type PurgeStatus = (typeof PURGE_STATUSES)[number];
export const PurgeStatusSchema = z.enum(PURGE_STATUSES);

// ---- Limits (each also enforced by the database or by the apply) --------------------------

/** A release note: shown in Versions (owner item O-4: optional, at most 280 characters). */
export const RELEASE_NOTE_MAX = 280;
/** Items in one release (program decision P-15: the dialog splits larger ones). */
export const RELEASE_MAX_ITEMS = 60;
/** A draft's payload and base (content_drafts CHECKs, pg_column_size). */
export const DRAFT_PAYLOAD_MAX_BYTES = 524_288;
/** The changed-column list a draft carries for display. */
export const DRAFT_FIELDS_MAX = 200;
/** One entry of that list: a column name, at most 63 characters (Postgres's identifier
 *  limit). The content_drafts CHECK uses the same pattern. */
export const DRAFT_FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;

// ---- Inputs ---------------------------------------------------------------------------------

/** A release note: trimmed, printable text only (no control characters, as for search). */
export const ReleaseNoteSchema = z
  .string()
  .trim()
  .max(RELEASE_NOTE_MAX, 'too-long')
  .refine((s) => !hasControlChars(s), 'control-chars');

/** One pending change the publisher saw, at the version they saw it. */
export const DraftRefSchema = z
  .object({
    draftId: z.string().uuid(),
    draftVersion: z.number().int().min(1),
  })
  .strict();
export type DraftRef = z.infer<typeof DraftRefSchema>;

/**
 * `POST /api/admin/releases` (publish now, R6) and its dry run. Strict: a field the
 * endpoint does not handle yet is refused, never ignored, so `scheduleAt` is a 400 until
 * scheduled releases (R11) add it here and handle it.
 */
export const PublishRequestSchema = z
  .object({
    items: z
      .array(DraftRefSchema)
      .min(1)
      .max(RELEASE_MAX_ITEMS)
      .refine((items) => new Set(items.map((i) => i.draftId)).size === items.length, {
        message: 'a change is listed twice',
      }),
    note: ReleaseNoteSchema.optional(),
    kind: z.enum(['publish', 'rollback']).default('publish'),
  })
  .strict();
export type PublishRequest = z.infer<typeof PublishRequestSchema>;

/** UTF-8 bytes of a JSON value as sent: the Worker's early check against the DB's cap. */
export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? '').length;
}

/**
 * A draft's payload: the merged camelCase input, an object. UNTRUSTED wherever it is read
 * back (anyone with the entity's write role can write it through the API): every consumer
 * re-parses it with the entity's own schema and toRow (releases.md A3-13). This checks only
 * the envelope.
 */
export const DraftPayloadSchema = z
  .record(z.string(), z.unknown())
  .refine((p) => jsonBytes(p) <= DRAFT_PAYLOAD_MAX_BYTES, 'too-large');

// ---- Rows as the database returns them (snake_case) -----------------------------------------

const Timestamp = z.string().min(1);
const Uuid = z.string().uuid();

export const ContentDraftRowSchema = z.object({
  id: Uuid,
  tenant_id: Uuid,
  entity_type: ReleaseEntityTypeSchema,
  entity_id: Uuid,
  op: DraftOpSchema,
  payload: z.record(z.string(), z.unknown()),
  fields: z.array(z.string().regex(DRAFT_FIELD_NAME)).max(DRAFT_FIELDS_MAX),
  base: z.record(z.string(), z.unknown()),
  base_version: z.number().int().nullable(),
  label: z.record(z.string(), z.unknown()).nullable(),
  origin_kind: z.literal('restore').nullable(),
  origin_release_id: Uuid.nullable(),
  release_id: Uuid.nullable(),
  version: z.number().int().min(1),
  created_at: Timestamp,
  updated_at: Timestamp,
  created_by: Uuid.nullable(),
  updated_by: Uuid.nullable(),
});
export type ContentDraftRow = z.infer<typeof ContentDraftRowSchema>;

export const ContentReleaseRowSchema = z.object({
  id: Uuid,
  tenant_id: Uuid,
  number: z.number().int().min(1).nullable(),
  kind: ReleaseKindSchema,
  status: ReleaseStatusSchema,
  note: z.string().max(RELEASE_NOTE_MAX).nullable(),
  scheduled_for: Timestamp.nullable(),
  scheduled_by: Uuid.nullable(),
  published_at: Timestamp.nullable(),
  published_by: Uuid.nullable(),
  restores_release_id: Uuid.nullable(),
  item_count: z.number().int().min(0),
  areas: z.array(ReleaseAreaSchema),
  tags: z.array(z.string()),
  purge_status: PurgeStatusSchema,
  purge_attempts: z.number().int().min(0),
  purge_next_at: Timestamp.nullable(),
  purged_at: Timestamp.nullable(),
  version: z.number().int().min(1),
  created_at: Timestamp,
  updated_at: Timestamp,
});
export type ContentReleaseRow = z.infer<typeof ContentReleaseRowSchema>;

export const ReleaseItemRowSchema = z.object({
  id: z.number().int().positive(),
  tenant_id: Uuid,
  release_id: Uuid,
  // A registry type, or the synthetic 'portfolio_children'.
  entity_type: z.string().regex(/^[a-z][a-z_]{1,39}$/),
  entity_id: Uuid,
  op: DraftOpSchema,
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  draft_id: Uuid.nullable(),
  actor_id: Uuid.nullable(),
  created_at: Timestamp,
});
export type ReleaseItemRow = z.infer<typeof ReleaseItemRowSchema>;

// ---- Applying a release (public.apply_release, migration 0051, R4) --------------------------
// R6 builds the RPC's arguments with ApplyRequestSchema and parses what comes back with
// ApplyResultSchema (publish) or DryRunReportSchema (dry run); the error details of BR403,
// BR409 and BR422 arrive as JSON text in the error's detail. The database re-checks every
// rule here (tests/schemas/release.spec.ts holds the two sides equal where they overlap).

/** The roles that may publish at all; each change is then the database's to allow. */
export const PUBLISHER_ROLES = ['admin', 'content_creator', 'seo', 'developer'] as const;
/** Media items in a case study's link set (save_portfolio and the apply refuse more). */
export const RELEASE_CHILD_MEDIA_MAX = 40;
/** The largest draft version the apply reads (an int, nine digits). */
const DRAFT_VERSION_MAX = 999_999_999;

/** Column values keyed by column name: a change as the Worker's toRow writes it. */
export const ColumnValuesSchema = z.record(z.string().regex(DRAFT_FIELD_NAME), z.unknown());

/** A case study's link sets, each replaced as a whole; absent or null leaves a set as it is. */
export const ApplyChildrenSchema = z
  .object({
    service_ids: z.array(Uuid).nullable().optional(),
    media: z
      .array(z.record(z.string(), z.unknown()))
      .max(RELEASE_CHILD_MEDIA_MAX)
      .nullable()
      .optional(),
  })
  .strict();

/**
 * One change as `public.apply_release` takes it (snake_case, as the RPC reads it): the
 * draft and the version the publisher saw, the entity, the operation, the change as column
 * values, the live values of those columns when the draft began, and a case study's link
 * sets.
 */
export const ApplyItemSchema = z
  .object({
    draft_id: Uuid,
    draft_version: z.number().int().min(1).max(DRAFT_VERSION_MAX),
    entity_type: ReleaseEntityTypeSchema,
    entity_id: Uuid,
    op: DraftOpSchema,
    patch: ColumnValuesSchema,
    base: ColumnValuesSchema,
    children: ApplyChildrenSchema.optional(),
  })
  .strict()
  .superRefine((item, ctx) => {
    const patched = Object.keys(item.patch);
    if (item.op === 'delete' && patched.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['patch'], message: 'a removal carries no patch' });
    }
    if (item.children && (item.entity_type !== 'portfolio' || item.op === 'delete')) {
      ctx.addIssue({
        code: 'custom',
        path: ['children'],
        message: 'only a case study that stays carries link sets',
      });
    }
    if (item.op === 'update' && patched.length === 0 && !item.children) {
      ctx.addIssue({ code: 'custom', path: ['patch'], message: 'the change changes nothing' });
    }
    if (item.op === 'update') {
      for (const column of patched) {
        if (!Object.hasOwn(item.base, column)) {
          ctx.addIssue({ code: 'custom', path: ['base', column], message: 'base-missing' });
        }
      }
    }
    if (item.patch.status === 'scheduled') {
      ctx.addIssue({
        code: 'custom',
        path: ['patch', 'status'],
        message: 'schedule the release, not the change',
      });
    }
  });
export type ApplyItem = z.infer<typeof ApplyItemSchema>;

/** The changes of one release: 1 to RELEASE_MAX_ITEMS, each draft once. */
export const ApplyItemsSchema = z
  .array(ApplyItemSchema)
  .min(1)
  .max(RELEASE_MAX_ITEMS)
  .refine((items) => new Set(items.map((i) => i.draft_id)).size === items.length, {
    message: 'a change is listed twice',
  });

/** `public.apply_release`'s arguments as R6 sends them (schedule and fire arrive with R11). */
export const ApplyRequestSchema = z
  .object({
    p_actor: Uuid,
    p_role: z.enum(PUBLISHER_ROLES),
    p_mode: z.enum(['publish', 'dry_run']),
    p_items: ApplyItemsSchema,
    p_note: ReleaseNoteSchema.nullable().optional(),
    p_kind: z.enum(['publish', 'rollback']).default('publish'),
    p_restores_release_id: Uuid.nullable().optional(),
  })
  .strict()
  .refine((r) => (r.p_kind === 'rollback') === (r.p_restores_release_id != null), {
    message: 'a rollback names the version it restores, and a publish none',
    path: ['p_restores_release_id'],
  });
export type ApplyRequest = z.infer<typeof ApplyRequestSchema>;

/** A team-member change in a publish's answer: applied, but no images kept (owner item O-12). */
export const TeamMemberApplyItemSchema = z
  .object({
    entity_type: z.literal('team_member'),
    entity_id: Uuid,
    op: DraftOpSchema,
    draft_id: Uuid,
  })
  .strict();

/** What a publish answers: the release, its number, and every item it recorded. */
export const ApplyResultSchema = z
  .object({
    release_id: Uuid,
    number: z.number().int().min(1),
    items: z.array(z.union([ReleaseItemRowSchema, TeamMemberApplyItemSchema])),
  })
  .strict();
export type ApplyResult = z.infer<typeof ApplyResultSchema>;

/** One change the database refused: the draft (null when no single change was at fault),
 *  the SQLSTATE, and the constraint and column it named, for the field-level message. */
export const ApplyItemErrorSchema = z
  .object({
    draftId: Uuid.nullable(),
    sqlstate: z.string().regex(/^[0-9A-Z]{5}$/),
    constraint: z.string().nullable(),
    column: z.string().nullable(),
    message: z.string(),
  })
  .strict();

/** The live site moved under a pending change: the columns that moved (a dry run adds the
 *  live and base values, for "Compare"), or the row is gone. */
export const ApplyConflictSchema = z.union([
  z.object({ draftId: Uuid, removed: z.literal(true) }).strict(),
  z
    .object({
      draftId: Uuid,
      columns: z.array(z.string()).min(1),
      live: z.record(z.string(), z.unknown()).optional(),
      base: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
]);

/** BR403: this person cannot publish now (inactive, locked, another role, no CMS role). */
export const ApplyForbiddenDetailSchema = z.object({ code: z.literal('actor') }).strict();

/** BR409: a draft moved since it was read, or the live site moved under one. */
export const ApplyConflictDetailSchema = z.discriminatedUnion('code', [
  z.object({ code: z.literal('pending-changed'), draftIds: z.array(Uuid).min(1) }).strict(),
  z.object({ code: z.literal('conflict'), items: z.array(ApplyConflictSchema).min(1) }).strict(),
]);

/** BR422: the database refused a change (a publish stops at the first), or a draft carries
 *  no base for a column it changes. */
export const ApplyRefusedDetailSchema = z.discriminatedUnion('code', [
  z.object({ code: z.literal('refused'), items: z.array(ApplyItemErrorSchema).min(1) }).strict(),
  z
    .object({
      code: z.literal('base-missing'),
      draftId: Uuid,
      columns: z.array(z.string()).min(1),
    })
    .strict(),
]);

/** What a dry run answers: every change's outcome, and nothing kept. */
export const DryRunReportSchema = z
  .object({
    mode: z.literal('dry_run'),
    ok: z.boolean(),
    item_count: z.number().int().min(1).max(RELEASE_MAX_ITEMS),
    conflicts: z.array(ApplyConflictSchema),
    errors: z.array(ApplyItemErrorSchema),
  })
  .strict();
export type DryRunReport = z.infer<typeof DryRunReportSchema>;
