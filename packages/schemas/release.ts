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
  // Admin v2 U14a (0057): who can see each page.
  'page_visibility',
  // Admin v2 U7 (0098): the FAQ.
  'faq_item',
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

// ---- Scheduling (Admin v2 R11) ---------------------------------------------------------------

/** A scheduled release goes live at least this many minutes ahead (releases.md §4.7). */
export const RELEASE_SCHEDULE_MIN_MINUTES = 2;
/** ...and at most this many days ahead. The database refuses outside 1 minute to 366 days. */
export const RELEASE_SCHEDULE_MAX_DAYS = 366;

/**
 * When a release goes live: an ISO 8601 time WITH its offset (the dialog sends the studio's
 * time, Riyadh by default, as an instant), never a local time a server would have to guess the
 * zone of. Whether it is far enough ahead is the endpoint's to judge (it depends on now).
 */
export const ScheduleAtSchema = z.string().datetime({ offset: true });

/**
 * `POST /api/admin/releases` (publish now, R6; or, with `scheduleAt`, schedule it, R11) and
 * its dry run. Strict: a field the endpoint does not handle is refused, never ignored.
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
    scheduleAt: ScheduleAtSchema.optional(),
  })
  .strict();
export type PublishRequest = z.infer<typeof PublishRequestSchema>;

/** `PATCH /api/admin/releases/[id]`: move a scheduled release, at the version read. */
export const RescheduleRequestSchema = z
  .object({ version: z.number().int().min(1), scheduleAt: ScheduleAtSchema })
  .strict();
export type RescheduleRequest = z.infer<typeof RescheduleRequestSchema>;

/**
 * Why a scheduled release could not go live: a closed list, the words are the screens'
 * (`fail_scheduled_release`'s CHECK holds the same list, tests/lib/releaseScheduleSql.spec.ts).
 */
export const RELEASE_FAILURE_CODES = [
  // The person who scheduled it can no longer publish: inactive, locked, another role, gone.
  'scheduler',
  // Their role no longer publishes one of its changes.
  'forbidden',
  // A change is not as the release holds it.
  'changed',
  // The live site moved under one of its changes.
  'conflict',
  // The database refused a change as that person.
  'refused',
  // Releases were switched off since.
  'releases-off',
  // Anything else.
  'error',
] as const;
export type ReleaseFailureCode = (typeof RELEASE_FAILURE_CODES)[number];

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

// ---- The ledger as a whole (migration 0066, R5) ---------------------------------------------
// Since R5 the ledger also holds SYSTEM ITEMS: a write outside a release (the runbook, a cron,
// the Worker's service-role client) to a tenant with releases on is recorded with no release
// and no draft, so a restore (R10) sees every change since a version. A release's own items
// (ApplyResultSchema) always name it: ReleaseItemRowSchema stays as it is.

/** Any row of content_release_items: a release's item, or a system item (no release, no draft). */
export const LedgerItemRowSchema = ReleaseItemRowSchema.extend({
  release_id: Uuid.nullable(),
}).refine((row) => row.release_id !== null || row.draft_id === null, {
  message: 'a system item names no draft',
  path: ['draft_id'],
});
export type LedgerItemRow = z.infer<typeof LedgerItemRowSchema>;

// ---- What the dashboard lists (public.dashboard_attention v4, migration 0066, R5) ------------
// The release kinds the attention list can emit, and the thresholds the view's SQL holds as
// literals (tests/lib/attentionKinds.spec.ts and tests/schemas/release.spec.ts compare them).
export const RELEASE_ATTENTION_KINDS = [
  'release_scheduled_today',
  'release_overdue',
  'release_failed',
  'purge_failed',
  'draft_stale',
] as const;
export type ReleaseAttentionKind = (typeof RELEASE_ATTENTION_KINDS)[number];
/** A pending change nobody has touched for this many days is listed. */
export const DRAFT_STALE_DAYS = 30;
/** A scheduled release this many minutes past its time is late, not "today". */
export const RELEASE_OVERDUE_MINUTES = 5;
/** A failed release, or a failed purge, is listed for this many days. */
export const RELEASE_ATTENTION_WINDOW_DAYS = 7;

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
  .strict()
  .refine((c) => c.service_ids != null || c.media != null, {
    message: 'link sets name at least one set',
  });

/**
 * One change as `public.apply_release` takes it (snake_case, as the RPC reads it): the
 * draft and the version the publisher saw, the entity, the operation, the change as column
 * values, the live values of those columns when the draft began (the draft's own `base`,
 * which the database compares with and reads, never the request's), and a case study's link
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

/** `public.apply_release`'s arguments to publish or dry-run (R6); a schedule and a fire have their own (R11). */
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

/** `apply_release` in `schedule` mode (R11): a publish's arguments and the time it goes live. */
export const ScheduleApplyRequestSchema = z
  .object({
    p_actor: Uuid,
    p_role: z.enum(PUBLISHER_ROLES),
    p_mode: z.literal('schedule'),
    p_items: ApplyItemsSchema,
    p_note: ReleaseNoteSchema.nullable().optional(),
    p_kind: z.literal('publish').default('publish'),
    p_scheduled_for: ScheduleAtSchema,
  })
  .strict();
export type ScheduleApplyRequest = z.infer<typeof ScheduleApplyRequestSchema>;

/** `apply_release` in `fire` mode (R11): the release and its scheduler, nothing else. */
export const FireApplyRequestSchema = z
  .object({
    p_actor: Uuid,
    p_role: z.enum(PUBLISHER_ROLES),
    p_mode: z.literal('fire'),
    p_items: z.null(),
    p_release_id: Uuid,
  })
  .strict();
export type FireApplyRequest = z.infer<typeof FireApplyRequestSchema>;

/** What a schedule answers: the release, when, and the version a move or a cancel names. */
export const ScheduleAnswerSchema = z.object({
  mode: z.literal('schedule'),
  release_id: Uuid,
  scheduled_for: z.string().min(1),
  version: z.number().int().min(1),
  item_count: z.number().int().min(1).max(RELEASE_MAX_ITEMS),
});

/** What a fire answers when it did nothing: the release went live, moved or was cancelled. */
export const FireSkippedSchema = z.object({
  mode: z.literal('fire'),
  release_id: Uuid,
  skipped: z.literal(true),
  status: z.string().nullable(),
});

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

// ---- Staged writes (public.write_drafts, migration 0062, R3a) -------------------------------
// The Worker builds the draft writer's arguments with WriteDraftsOpsSchema and reads its answer
// with WriteDraftsResultSchema; BR409's detail arrives as JSON text (DraftConflictDetailSchema).
// The database re-checks every cap here (tests/schemas/release.spec.ts holds the two equal).

/** Changes in one write_drafts call (a reorder's 200 rows fit in one). */
export const WRITE_DRAFTS_MAX_OPS = 200;
/** A draft's display label (the content_drafts CHECK, pg_column_size). */
export const DRAFT_LABEL_MAX_BYTES = 4096;
/** Each language of a label, in characters. */
export const DRAFT_LABEL_TEXT_MAX = 200;

/**
 * The pending change a save edits, as a PATCH names it: both or neither. Without it a save
 * is checked against the live row's `version`; with it, against the draft's.
 */
export const DraftRefFieldsSchema = z
  .object({
    draftId: z.string().uuid().optional(),
    draftVersion: z.number().int().min(1).max(DRAFT_VERSION_MAX).optional(),
  })
  .refine((ref) => (ref.draftId === undefined) === (ref.draftVersion === undefined), {
    message: 'a pending change is named by its id and version together',
    path: ['draftVersion'],
  });
export type DraftRefFields = z.infer<typeof DraftRefFieldsSchema>;

/** A list's label for a pending change: `{en, ar?}`, display only. */
export const DraftLabelSchema = z
  .object({
    en: z.string().max(DRAFT_LABEL_TEXT_MAX),
    ar: z.string().max(DRAFT_LABEL_TEXT_MAX).optional(),
  })
  .strict()
  .refine((label) => jsonBytes(label) <= DRAFT_LABEL_MAX_BYTES, 'too-large');
export type DraftLabel = z.infer<typeof DraftLabelSchema>;

const DraftFieldsSchema = z.array(z.string().regex(DRAFT_FIELD_NAME)).max(DRAFT_FIELDS_MAX);
const DraftVersionSchema = z.number().int().min(1).max(DRAFT_VERSION_MAX);

/** One put: a new draft (no draft_id), or an edit of one at the version read. */
export const WriteDraftsPutSchema = z
  .object({
    action: z.literal('put'),
    entity_type: ReleaseEntityTypeSchema,
    entity_id: Uuid,
    op: DraftOpSchema,
    payload: DraftPayloadSchema,
    fields: DraftFieldsSchema,
    base: DraftPayloadSchema,
    base_version: DraftVersionSchema.nullable(),
    label: DraftLabelSchema.nullable(),
    draft_id: Uuid.optional(),
    expected_version: DraftVersionSchema.optional(),
  })
  .strict()
  .superRefine((op, ctx) => {
    if ((op.draft_id === undefined) !== (op.expected_version === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['expected_version'], message: 'both or neither' });
    }
    if (op.op === 'delete' && Object.keys(op.payload).length > 0) {
      ctx.addIssue({ code: 'custom', path: ['payload'], message: 'a removal carries no payload' });
    }
    if (op.op === 'create' && op.base_version !== null) {
      ctx.addIssue({ code: 'custom', path: ['base_version'], message: 'a create has no base' });
    }
  });

/** One discard, at the version read (never blind). */
export const WriteDraftsDiscardSchema = z
  .object({
    action: z.literal('discard'),
    draft_id: Uuid,
    expected_version: DraftVersionSchema,
    entity_type: ReleaseEntityTypeSchema.optional(),
    entity_id: Uuid.optional(),
  })
  .strict();

export const WriteDraftsOpSchema = z.union([WriteDraftsPutSchema, WriteDraftsDiscardSchema]);
export type WriteDraftsOp = z.infer<typeof WriteDraftsOpSchema>;
export const WriteDraftsOpsSchema = z.array(WriteDraftsOpSchema).min(1).max(WRITE_DRAFTS_MAX_OPS);

/** What write_drafts answers: one entry per change, in the order it ran them. */
export const WriteDraftsResultSchema = z.array(
  z
    .object({
      action: z.enum(['put', 'discard']),
      draft_id: Uuid,
      entity_type: ReleaseEntityTypeSchema,
      entity_id: Uuid,
      version: DraftVersionSchema.nullable(),
    })
    .strict(),
);
export type WriteDraftsResult = z.infer<typeof WriteDraftsResultSchema>;

/** BR409's detail from write_drafts: which draft, and why. */
export const DraftConflictDetailSchema = z
  .object({
    code: z.enum(['draft-conflict', 'scheduled']),
    draft_id: Uuid.nullable().optional(),
    entity_type: z.string().nullable().optional(),
    entity_id: Uuid.nullable().optional(),
  })
  .strict();

/**
 * Why a staged save was refused with 409 (releases.md §3, §4.5): the pending change moved on
 * (`draft-conflict`), was published or thrown away since the form read it, is claimed by a
 * scheduled release, or (a bulk discard, R3b) several moved at once.
 */
export const DRAFT_CONFLICT_CODES = [
  'draft-conflict',
  'draft-published',
  'draft-discarded',
  'scheduled',
  'pending-changed',
] as const;
export type DraftConflictCode = (typeof DRAFT_CONFLICT_CODES)[number];

// ---- The draft endpoints and the intake switch (Admin v2 R3b) -------------------------------
// `POST /api/admin/drafts/discard`, `POST /api/admin/drafts/[id]/resolve`,
// `PATCH /api/admin/site-profile/intake` and the answer of `GET /api/admin/releases/pending`.

/** Throwing pending changes away in one go: all of mine, or the ones the person selected. */
export const DiscardRequestSchema = z.union([
  z.object({ scope: z.literal('mine') }).strict(),
  z
    .object({
      items: z
        .array(DraftRefSchema)
        .min(1)
        .max(WRITE_DRAFTS_MAX_OPS)
        .refine((items) => new Set(items.map((i) => i.draftId)).size === items.length, {
          message: 'a change is listed twice',
        }),
    })
    .strict(),
]);
export type DiscardRequest = z.infer<typeof DiscardRequestSchema>;

const ColumnListSchema = z
  .array(z.string().regex(DRAFT_FIELD_NAME))
  .max(DRAFT_FIELDS_MAX)
  .refine((list) => new Set(list).size === list.length, { message: 'a column is listed twice' });

/**
 * Settling a pending change the live site moved under (releases.md §4.5): per column, "Keep
 * mine" (the change now starts from what live holds) or "Use the live version" (the change
 * stops writing it). At least one column; never both for one column.
 */
export const ResolveRequestSchema = z
  .object({
    version: DraftVersionSchema,
    keepMine: ColumnListSchema.default([]),
    useLive: ColumnListSchema.default([]),
  })
  .strict()
  .refine((r) => r.keepMine.length + r.useLive.length > 0, {
    message: 'name at least one column',
    path: ['keepMine'],
  })
  .refine((r) => !r.keepMine.some((column) => r.useLive.includes(column)), {
    message: 'a column is either kept or taken from live, not both',
    path: ['useLive'],
  });
export type ResolveRequest = z.infer<typeof ResolveRequestSchema>;

/** Opening or closing job applications: one boolean, written at once whatever the flag. */
export const IntakeRequestSchema = z.object({ acceptingApplications: z.boolean() }).strict();
export type IntakeRequest = z.infer<typeof IntakeRequestSchema>;

/** One pending change as the summary lists it (stored metadata only, never the payload). */
export const PendingItemSchema = z
  .object({
    draftId: Uuid,
    draftVersion: DraftVersionSchema,
    entityType: ReleaseEntityTypeSchema,
    entityId: Uuid,
    op: DraftOpSchema,
    area: ReleaseAreaSchema,
    label: z.record(z.string(), z.unknown()).nullable(),
    fields: z.array(z.string()),
    updatedBy: Uuid.nullable(),
    updatedByName: z.string().nullable(),
    updatedAt: Timestamp,
    scheduled: z.boolean(),
    mine: z.boolean(),
    publishableByMe: z.boolean(),
    requiredCaps: z.array(z.string()).nullable(),
    waitingFor: z.array(z.string()),
    /** Admin v2 R12: the status and the go-live flag the change stores, as stored (its badge). */
    status: z.string().nullable(),
    visible: z.boolean().nullable(),
    /** Admin v2 R12: where the change is edited (the dialog's "Fix" and its row link). */
    href: z.string().nullable(),
    /** Admin v2 R12: the changed fields in the editor's words ("Title, Intro, +2"). */
    fieldLabels: z.array(z.string()),
  })
  .strict();
export type PendingItem = z.infer<typeof PendingItemSchema>;

/**
 * Admin v2 R12, `GET /api/admin/drafts/[id]/compare` (Compare, releases.md §7 "Conflicts"):
 * per column the live site moved since the change began, what live holds now and what the
 * change writes, as plain or bilingual text (R10's field formatter: 300 characters at most,
 * anything else only "changed"). `removed`: the live row is gone under the change.
 */
export const CompareColumnSchema = z
  .object({
    column: z.string(),
    label: z.string(),
    kind: z.enum(['text', 'bilingual', 'changed']),
    live: z.unknown().optional(),
    yours: z.unknown().optional(),
  })
  .strict();
export type CompareColumn = z.infer<typeof CompareColumnSchema>;

export const CompareResultSchema = z
  .object({
    draftId: Uuid,
    draftVersion: DraftVersionSchema,
    removed: z.boolean(),
    columns: z.array(CompareColumnSchema),
  })
  .strict();
export type CompareResult = z.infer<typeof CompareResultSchema>;

// ---- Publishing and its check (the publish and validate endpoints, Admin v2 R6) -------------
// `POST /api/admin/releases/validate` answers a ReleaseCheck: per selected change, what stops it
// (`errors`), what the person should know (`warnings`), the pending changes it needs
// (`requires`, the dialog ticks them) and, from the database's dry run, a conflict. `POST
// /api/admin/releases` runs the same check and publishes only when nothing stops any change.

/** Why a change cannot be published as it stands (a closed list R12's dialog words). */
export const RELEASE_ISSUE_CODES = [
  // The stored change no longer reads as one (written around the API, or an old shape).
  'unreadable',
  // A rule refused it (a schema or domain rule; `field` names the field).
  'invalid',
  // It was saved without the live values it started from: open it and save again.
  'base-missing',
  // It no longer changes anything.
  'nothing',
  // A first save of something that has since been set up on the live site.
  'exists-live',
  // The live row it changes (or removes) is gone.
  'removed',
  // It points at something that is not on this site.
  'link',
  // It points at a pending new item that is not in the selection.
  'requires',
  // It points at a pending new item a scheduled release holds (R11): it cannot be added, so
  // this waits until that release goes live, or is unscheduled.
  'requires-scheduled',
  // It points at something this release removes.
  'parent-removed',
  // Entity SEO: the page it describes is not the one it was made for, or does not exist.
  'target',
  // The database refused it in the dry run.
  'refused',
  // The live site moved under it since it was made (the dry run's conflict).
  'conflict',
] as const;
export type ReleaseIssueCode = (typeof RELEASE_ISSUE_CODES)[number];

/** What the person should know but that does not stop the publish. */
export const RELEASE_WARNING_CODES = ['hidden-by-discipline'] as const;
export type ReleaseWarningCode = (typeof RELEASE_WARNING_CODES)[number];

export const ReleaseIssueSchema = z
  .object({
    code: z.enum(RELEASE_ISSUE_CODES),
    message: z.string(),
    field: z.string().optional(),
  })
  .strict();
export type ReleaseIssue = z.infer<typeof ReleaseIssueSchema>;

export const ReleaseWarningSchema = z
  .object({ code: z.enum(RELEASE_WARNING_CODES), message: z.string() })
  .strict();
export type ReleaseWarning = z.infer<typeof ReleaseWarningSchema>;

/** One selected change, checked. */
export const ReleaseCheckItemSchema = z
  .object({
    draftId: Uuid,
    draftVersion: DraftVersionSchema,
    entityType: ReleaseEntityTypeSchema,
    entityId: Uuid,
    op: DraftOpSchema,
    area: ReleaseAreaSchema,
    label: z.record(z.string(), z.unknown()).nullable(),
    errors: z.array(ReleaseIssueSchema),
    warnings: z.array(ReleaseWarningSchema),
    /** Pending new items this change links to that the selection leaves out. */
    requires: z.array(DraftRefSchema),
    /** The dry run's conflict: the columns live moved in (with the values, for "Compare"). */
    conflict: ApplyConflictSchema.optional(),
  })
  .strict();
export type ReleaseCheckItem = z.infer<typeof ReleaseCheckItemSchema>;

/**
 * The whole check: `ok` when no change has an error. `dryRun` says whether the database's dry
 * run ran (only when the Worker found nothing to fix first: a dry run over a selection with a
 * change that cannot be sent would report what the missing change causes, not what is wrong).
 */
export const ReleaseCheckSchema = z
  .object({
    ok: z.boolean(),
    items: z.array(ReleaseCheckItemSchema),
    /** Refusals that name no single change. */
    errors: z.array(ReleaseIssueSchema),
    dryRun: z.enum(['ran', 'skipped']),
  })
  .strict();
export type ReleaseCheck = z.infer<typeof ReleaseCheckSchema>;

/** What a publish answers. The purge is a logged no-op until a cache zone exists (O-3, R7). */
export const PublishResultSchema = z
  .object({
    release: z.object({ id: Uuid, number: z.number().int().min(1) }).strict(),
    items: z.array(
      z.object({ entityType: z.string(), entityId: Uuid, op: DraftOpSchema }).strict(),
    ),
    warnings: z.array(
      z.object({ draftId: Uuid, code: z.enum(RELEASE_WARNING_CODES), message: z.string() }),
    ),
    purge: PurgeStatusSchema,
    /** Present when the release changed redirects or page visibility: did the edge take it. */
    kvSynced: z.boolean().optional(),
  })
  .strict();
export type PublishResult = z.infer<typeof PublishResultSchema>;

/**
 * What a schedule answers (R11): the scheduled release (its `version` is what a move or a
 * cancel names), the changes it holds and the check's warnings. Nothing is live yet.
 */
export const ScheduleResultSchema = z
  .object({
    release: z
      .object({
        id: Uuid,
        scheduledFor: z.string().min(1),
        version: z.number().int().min(1),
      })
      .strict(),
    items: z.array(
      z.object({ entityType: z.string(), entityId: Uuid, op: DraftOpSchema }).strict(),
    ),
    warnings: z.array(
      z.object({ draftId: Uuid, code: z.enum(RELEASE_WARNING_CODES), message: z.string() }),
    ),
  })
  .strict();
export type ScheduleResult = z.infer<typeof ScheduleResultSchema>;

// ---- Versions, history and restore (Admin v2 R10) -------------------------------------------
// `GET /api/admin/releases` (the versions), `GET /api/admin/releases/[id]` (one version's
// changes), `POST /api/admin/releases/[id]/restore` (stage the state at vN), `GET
// /api/admin/history` and `POST /api/admin/history/restore` (one entity's numbered snapshots),
// and what `public.release_as_of` (migration 0104) answers. The answers' row schemas are not
// strict: an expand migration may add a key the deployed Worker must ignore (corrections rule 5).

/** The most entities a restore reads from the ledger (one write_drafts call holds 200). */
export const RESTORE_SCAN_MAX = WRITE_DRAFTS_MAX_OPS;
/** The most entities a preview of a version lays over live (the preview reads 2,000 rows a table). */
export const AS_OF_PREVIEW_MAX = 500;
/** A version's changes read at once (at most 60 changes, plus their cascades and link sets). */
export const VERSION_ITEMS_MAX = 1000;
/** Versions, and history rows, per page. */
export const VERSIONS_PAGE = 50;

const EntityTypeText = z.string().regex(/^[a-z][a-z_]{1,39}$/);

/** One entity in the state at a version: its image then (null: it did not exist) and now. */
export const AsOfEntitySchema = z.object({
  entity_type: EntityTypeText,
  entity_id: Uuid,
  before: z.record(z.string(), z.unknown()).nullable(),
  exists_now: z.boolean(),
  page_id: z.string().nullable().optional(),
  /** Gone now: the first-publish date it held when it was removed (a restore gives it back). */
  removed_published_at: z.string().nullable().optional(),
});
export type AsOfEntity = z.infer<typeof AsOfEntitySchema>;

/** `public.release_as_of(p_tenant, p_number, p_limit, p_page)` (0104). */
export const AsOfAnswerSchema = z.object({
  release: z.object({
    id: Uuid,
    number: z.number().int().min(1),
    kind: ReleaseKindSchema,
    note: z.string().nullable(),
    published_at: Timestamp.nullable(),
    published_by: Uuid.nullable(),
  }),
  cutoff: z.number().int().min(0),
  total: z.number().int().min(0),
  entities: z.array(AsOfEntitySchema),
});
export type AsOfAnswer = z.infer<typeof AsOfAnswerSchema>;

/** The versions list's query: the page before a number (newest first). */
export const VersionsQuerySchema = z
  .object({ before: z.coerce.number().int().min(2).max(1_000_000_000).optional() })
  .strict();

/** Restoring a version: the whole site, or one page and its sections (the page editor's). */
export const RestoreVersionRequestSchema = z.object({ pageId: Uuid.optional() }).strict();
export type RestoreVersionRequest = z.infer<typeof RestoreVersionRequestSchema>;

/** One entity's history: its own snapshots, or (a page) every version that touched it. */
export const HistoryQuerySchema = z
  .object({
    entityType: ReleaseEntityTypeSchema,
    entityId: Uuid,
    scope: z.enum(['item', 'page']).default('item'),
    before: z.coerce.number().int().min(2).max(1_000_000_000).optional(),
  })
  .strict();
export type HistoryQuery = z.infer<typeof HistoryQuerySchema>;

/** Restoring one snapshot of one entity. */
export const HistoryRestoreRequestSchema = z
  .object({
    entityType: ReleaseEntityTypeSchema,
    entityId: Uuid,
    seq: z.number().int().min(1).max(1_000_000_000),
  })
  .strict();
export type HistoryRestoreRequest = z.infer<typeof HistoryRestoreRequestSchema>;

/** Why one entity stops a restore, or is left as it is. */
export const RESTORE_REASONS = [
  // It has a pending change already: publish or discard it first.
  'pending',
  // The person cannot publish this change (Admin and the publishers only, P-2).
  'forbidden',
  // The version links to something that is gone and that the restore does not bring back.
  'link-gone',
  // Its address (a slug, a redirect's source) now belongs to another item.
  'address-taken',
  // Its stored image no longer reads as a change the editor could make.
  'unrestorable',
  // A quote whose consent a restore cannot bring back (R10): one removed since, or one the
  // restore would publish while its consent is not recorded now.
  'consent',
  // Left as it is: no role removes it through a release (the site identity, SEO details).
  'kept',
] as const;
export type RestoreReason = (typeof RESTORE_REASONS)[number];

export const RestoreItemSchema = z.object({
  entityType: ReleaseEntityTypeSchema,
  entityId: Uuid,
  label: z.record(z.string(), z.unknown()).nullable(),
  reason: z.enum(RESTORE_REASONS),
  /** The field (payload key) a gone link is on, or the columns that do not come back. */
  field: z.string().optional(),
  columns: z.array(z.string()).optional(),
  waitingFor: z.array(z.string()).optional(),
});
export type RestoreItem = z.infer<typeof RestoreItemSchema>;

/** What a restore answers: the pending changes it staged, and what it left as it is. */
export const RestoreResultSchema = z.object({
  /** The version restored (one item's: the version that wrote its snapshot, if any). */
  release: z.object({ id: Uuid, number: z.number().int().min(1) }).nullable(),
  scope: z.enum(['site', 'page', 'item']),
  staged: z.array(
    z.object({
      draftId: Uuid,
      draftVersion: DraftVersionSchema,
      entityType: ReleaseEntityTypeSchema,
      entityId: Uuid,
      op: DraftOpSchema,
      label: z.record(z.string(), z.unknown()).nullable(),
    }),
  ),
  kept: z.array(RestoreItemSchema),
  /** False when the changes were staged but could not be marked as a restore (logged). */
  marked: z.boolean(),
});
export type RestoreResult = z.infer<typeof RestoreResultSchema>;
