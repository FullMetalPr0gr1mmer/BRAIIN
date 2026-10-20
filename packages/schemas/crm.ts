import { z } from 'zod';
import { BudgetBandSchema } from './lead';
import { SlugSchema } from './primitives';

// The CRM's closed vocabularies (Admin v2, docs/admin-v2/crm.md §4 and §6.3). The SQL
// CHECKs in supabase/migrations/0035_crm_ingest.sql carry the same lists; a test parses
// the migration and compares (tests/lib/crmScore.spec.ts).

/**
 * Why a lead scores what it scores. Computed in the Worker from the plaintext BEFORE it is
 * encrypted and stored as keys only: the budget and the timeline never reach the score
 * column, only the fact that they were given. `returning` is set by the database (the
 * e-mail's blind index was seen before); `service_page` arrives with attribution (C13).
 */
export const SCORE_SIGNALS = [
  'named_service',
  'budget_given',
  'budget_200k_plus',
  'company_email',
  'company_named',
  'timeline_given',
  'returning',
  'service_page',
] as const;
export type ScoreSignal = (typeof SCORE_SIGNALS)[number];
export const ScoreSignalSchema = z.enum(SCORE_SIGNALS);

/** Points per signal (CRM settings edits them, 0 to 50 each, from C9). */
export const DEFAULT_SCORING: Readonly<Record<ScoreSignal, number>> = {
  service_page: 10,
  named_service: 10,
  budget_given: 15,
  budget_200k_plus: 25,
  company_email: 10,
  returning: 10,
  company_named: 5,
  timeline_given: 5,
};

export const CrmScoringSchema = z.record(ScoreSignalSchema, z.number().int().min(0).max(50));

/** The score is capped at 100, whatever the points add up to. */
export const MAX_LEAD_SCORE = 100;

/** Where a lead came from. Set by the server, never chosen by the client. */
export const LEAD_SOURCES = ['web_form', 'manual', 'import', 'style_finder'] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

/** How the person reached us (attribution fills it from C13; until then `unknown`). */
export const LEAD_CHANNELS = [
  'organic',
  'social',
  'paid',
  'referral',
  'direct',
  'email',
  'phone',
  'walk_in',
  'whatsapp',
  'event',
  'unknown',
] as const;
export type LeadChannel = (typeof LEAD_CHANNELS)[number];

// ---- Reading the pipeline (Admin v2 C2a, C4a) ---------------------------------------------
// The filter the lead list, board and summary accept. The database validates it again
// (app.lead_filter, migrations 0036 and 0063): two layers, and a 22023 for anything outside
// them.

const Instant = z.string().datetime({ offset: true });

/**
 * Whose leads (C4a): 'me' (the database reads the session's user, so a client never names
 * itself), 'none' (nobody has them yet) or a person's id.
 */
export const LeadAssignedFilterSchema = z.union([z.enum(['me', 'none']), z.string().uuid()]);
export type LeadAssignedFilter = z.infer<typeof LeadAssignedFilterSchema>;

/** A discipline's slug, as app.lead_filter takes it (at most 64 characters). */
const DisciplineFilterSchema = SlugSchema.max(64);

/** The list's orders: starred first (then newest) is the screen's default (C4 D6). */
export const LEAD_SORTS = ['newest', 'oldest', 'score', 'starred'] as const;

export const LeadQuerySchema = z
  .object({
    stage: z.string().uuid().optional(),
    spam: z.boolean().optional(),
    q: z.string().max(64).optional(),
    from: Instant.optional(),
    to: Instant.optional(),
    sort: z.enum(LEAD_SORTS).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).max(10000).optional(),
    // (C4a) who has it, its marks, and where it came from
    assigned: LeadAssignedFilterSchema.optional(),
    starred: z.boolean().optional(),
    unread: z.boolean().optional(),
    source: z.enum(LEAD_SOURCES).optional(),
    channel: z.enum(LEAD_CHANNELS).optional(),
    discipline: DisciplineFilterSchema.optional(),
  })
  .strict();
export type LeadQuery = z.infer<typeof LeadQuerySchema>;

/**
 * The board shows every stage and no spam, newest first, so it takes no stage, spam flag,
 * sort or page (app.lead_filter refuses them too, since 0063).
 */
export const LeadBoardQuerySchema = z
  .object({
    q: z.string().max(64).optional(),
    from: Instant.optional(),
    to: Instant.optional(),
    perStage: z.number().int().min(1).max(50).optional(),
    // (C4a)
    assigned: LeadAssignedFilterSchema.optional(),
    source: z.enum(LEAD_SOURCES).optional(),
    channel: z.enum(LEAD_CHANNELS).optional(),
    discipline: DisciplineFilterSchema.optional(),
  })
  .strict();
export type LeadBoardQuery = z.infer<typeof LeadBoardQuerySchema>;

/** The KPIs take a date range and nothing else. */
export const LeadSummaryQuerySchema = z
  .object({ from: Instant.optional(), to: Instant.optional() })
  .strict();

/**
 * Previous and Next on a lead's page (public.lead_neighbours, 0063): the list's filters a
 * URL may carry, so no search and no page (C4 D8; a search never sits in a URL, D10).
 */
export const LeadNeighboursQuerySchema = LeadQuerySchema.omit({
  q: true,
  limit: true,
  offset: true,
});
export type LeadNeighboursQuery = z.infer<typeof LeadNeighboursQuerySchema>;

// ---- One lead (Admin v2 C2b) --------------------------------------------------------------

/** A note on a lead: 1 to 5,000 characters, trimmed. Append-only. */
export const LeadNoteInputSchema = z.object({ body: z.string().trim().min(1).max(5000) }).strict();

/**
 * A page of a lead's timeline, at most 100: the events before the last one already shown,
 * named by its `at` AND its `id` (several events can share one instant), or neither.
 */
export const LeadEventsQuerySchema = z
  .object({
    before: Instant.optional(),
    beforeId: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict()
  .refine((page) => (page.before === undefined) === (page.beforeId === undefined), {
    message: 'before and beforeId go together',
    path: ['beforeId'],
  });

// ---- Writing the pipeline (Admin v2 C3) ---------------------------------------------------
// The shapes the write routes accept. The database checks the same rules again (migration
// 0041: the column CHECKs, app.tags_ok, the assignee rule in app.tg_lead_pipeline and the
// bulk door's own validation): two layers, and a 22023 or 23514 for anything outside them.

/** How a contact was made, for "Log contact" (leads.last_contact_channel). */
export const LEAD_CONTACT_CHANNELS = ['call', 'email', 'whatsapp', 'meeting', 'other'] as const;
export type LeadContactChannel = (typeof LEAD_CONTACT_CHANNELS)[number];

/** Control characters, which no tag may hold (app.tags_ok refuses them too). */
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A tag: 1 to 32 characters, trimmed, no control characters (app.tags_ok). */
export const LeadTagSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .refine((tag) => !CONTROL.test(tag), 'a tag has no control characters');

/** At most 10 tags, each once. */
export const LeadTagsSchema = z
  .array(LeadTagSchema)
  .max(10)
  .refine((tags) => new Set(tags).size === tags.length, 'each tag once');

/** The most a lead may be worth, in SAR (leads_value_sar_range). */
export const MAX_LEAD_VALUE_SAR = 10_000_000;

const LeadVersionSchema = z.number().int().min(1);

/** The legacy status: an export filter still reads it until C14 drops it (C4b removed its panel). */
const LegacyLeadStatusSchema = z.enum(['new', 'in_progress', 'done', 'spam']);

/** The PATCH fields that move a lead's version, so they need the version the caller read. */
export const VERSIONED_LEAD_FIELDS = [
  'stageId',
  'isSpam',
  'assignedTo',
  'valueSar',
  'tags',
] as const;

/** What a PATCH that still sends the legacy notes field is told (C4b, decision D4's fix). */
export const NOTES_ARE_A_THREAD = 'Notes are a thread now. Add a note instead.';

/** What a PATCH that still sends the legacy status is told (C10a: 0093 withdrew the column). */
export const STATUS_IS_A_STAGE = 'A lead moves by its stage now. Choose a stage instead.';

/**
 * PATCH /api/admin/leads/[id]. The pipeline fields need the `version` the caller read (a
 * 409 when it moved on); a star, a read mark and a logged contact do not, because they
 * never move it.
 *
 * `status` is refused (C10a): migration 0093 withdrew the staff UPDATE on the legacy column,
 * so a lead moves by its stage only (the database keeps the old column in step until C14).
 * Like `internalNotes`, the key stays known so the 422 names it and says what to do.
 *
 * `internalNotes` is refused (C4b): the notes are a thread now (POST …/[id]/notes, audited),
 * and a PATCH that rewrote the legacy field could blank what a colleague wrote there. The key
 * stays known, so the 422 names the field and says what to do, rather than "unknown key".
 */
export const LeadPatchSchema = z
  .object({
    version: LeadVersionSchema.optional(),
    stageId: z.string().uuid().optional(),
    isSpam: z.boolean().optional(),
    assignedTo: z.string().uuid().nullable().optional(),
    valueSar: z.number().int().min(0).max(MAX_LEAD_VALUE_SAR).nullable().optional(),
    tags: LeadTagsSchema.optional(),
    isStarred: z.boolean().optional(),
    read: z.boolean().optional(),
    logContact: z
      .object({ channel: z.enum(LEAD_CONTACT_CHANNELS) })
      .strict()
      .optional(),
    status: z.unknown().optional(),
    internalNotes: z.unknown().optional(),
  })
  .strict()
  .refine((patch) => patch.internalNotes === undefined, {
    message: NOTES_ARE_A_THREAD,
    path: ['internalNotes'],
  })
  .refine((patch) => patch.status === undefined, {
    message: STATUS_IS_A_STAGE,
    path: ['status'],
  })
  .refine(
    (patch) =>
      Object.entries(patch).some(([field, value]) => field !== 'version' && value !== undefined),
    { message: 'nothing to change' },
  )
  .refine(
    (patch) =>
      patch.version !== undefined ||
      VERSIONED_LEAD_FIELDS.every((field) => patch[field] === undefined),
    {
      message: 'send the version you read with a stage, spam, assignee, value or tags change',
      path: ['version'],
    },
  );
export type LeadPatch = z.infer<typeof LeadPatchSchema>;

/** One lead in a bulk change: its id, and the version read (versioned actions need it). */
const LeadBulkItemSchema = z
  .object({ id: z.string().uuid(), version: LeadVersionSchema.optional() })
  .strict();

const BulkItemsSchema = z
  .array(LeadBulkItemSchema)
  .min(1)
  .max(100)
  .refine((items) => new Set(items.map((item) => item.id.toLowerCase())).size === items.length, {
    message: 'each lead once',
  });
const VersionedBulkItemsSchema = BulkItemsSchema.refine(
  (items) => items.every((item) => item.version !== undefined),
  { message: 'this action needs the version of each lead' },
);

/**
 * POST /api/admin/leads/bulk: one action over up to 100 leads (public.leads_bulk_update).
 * There is no bulk delete: a lead leaves through spam (its retention) or an Admin's erase,
 * one lead at a time.
 */
export const LeadBulkSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('assign'),
      value: z.string().uuid().nullable(),
      items: VersionedBulkItemsSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('stage'),
      value: z.string().uuid(),
      items: VersionedBulkItemsSchema,
    })
    .strict(),
  z
    .object({ action: z.literal('spam'), value: z.boolean(), items: VersionedBulkItemsSchema })
    .strict(),
  z
    .object({ action: z.literal('tagAdd'), value: LeadTagSchema, items: VersionedBulkItemsSchema })
    .strict(),
  z
    .object({
      action: z.literal('tagRemove'),
      value: LeadTagSchema,
      items: VersionedBulkItemsSchema,
    })
    .strict(),
  z.object({ action: z.literal('read'), value: z.boolean(), items: BulkItemsSchema }).strict(),
  z.object({ action: z.literal('star'), value: z.boolean(), items: BulkItemsSchema }).strict(),
]);
export type LeadBulk = z.infer<typeof LeadBulkSchema>;
export type LeadBulkAction = LeadBulk['action'];

/** How someone reached us, for a lead staff add by hand ('unknown' reads as "Other"). */
export const MANUAL_LEAD_CHANNELS = [
  'phone',
  'walk_in',
  'whatsapp',
  'email',
  'event',
  'referral',
  'unknown',
] as const satisfies readonly LeadChannel[];

/**
 * POST /api/admin/leads: a lead added by hand (crm.md §7.2). A name, a message, and an
 * e-mail or a phone (at least one). The source is the server's ('manual'), never the
 * client's. A phone that matches an earlier lead while the e-mail does not is a possible
 * duplicate (409) unless `createNew` says this is someone else.
 */
export const LeadManualCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    company: z.string().trim().min(1).max(120).optional(),
    email: z.string().trim().email().max(254).optional(),
    phone: z.string().trim().min(3).max(32).optional(),
    serviceOfInterest: SlugSchema.optional(),
    // The bands the form offers today; a lead added by hand never needs a legacy one.
    budgetBand: BudgetBandSchema.optional(),
    timeline: z.string().trim().min(1).max(120).optional(),
    message: z.string().trim().min(1).max(5000),
    locale: z.enum(['en', 'ar']).default('en'),
    channel: z.enum(MANUAL_LEAD_CHANNELS),
    createNew: z.boolean().optional(),
  })
  .strict()
  .refine((lead) => lead.email !== undefined || lead.phone !== undefined, {
    message: 'add an e-mail address or a phone number',
    path: ['email'],
  });
export type LeadManualCreate = z.infer<typeof LeadManualCreateSchema>;

/** POST /api/admin/leads/[id]/erase: why (their request under PDPL, or our own decision). */
export const LeadEraseSchema = z.object({ reason: z.enum(['dsar', 'decision']) }).strict();

/**
 * GET /api/admin/leads/export: the list's filters a link may carry. Never `q`: a search
 * term in a URL lands in history and logs (verification D10).
 */
export const LeadExportQuerySchema = z
  .object({
    from: Instant.optional(),
    to: Instant.optional(),
    status: LegacyLeadStatusSchema.optional(),
    stage: z.string().uuid().optional(),
    spam: z.enum(['true', 'false']).optional(),
    // (C4a) the list's other filters, in a link's string form
    assigned: LeadAssignedFilterSchema.optional(),
    source: z.enum(LEAD_SOURCES).optional(),
    channel: z.enum(LEAD_CHANNELS).optional(),
    discipline: DisciplineFilterSchema.optional(),
    starred: z.enum(['true', 'false']).optional(),
    unread: z.enum(['true', 'false']).optional(),
  })
  .strict();
export type LeadExportQuery = z.infer<typeof LeadExportQuerySchema>;

// ── CRM settings (Admin v2 C9a) ─────────────────────────────────────────────────────────────
// The SQL side is supabase/migrations/0034 (the stage CHECKs), 0035 (scoring, sla_hours) and
// 0091 (the assignment rule, the pool, save_lead_stages); tests/lib/crmSettings.spec.ts parses
// them and compares.

/**
 * A stage's tone: a named, closed palette (`.badge[data-tone]` in admin.css), never a colour.
 * Free colours would need inline style, which the CSP forbids (§3), and each of these is a
 * text-on-tint pair scripts/contrast-audit.mjs holds to WCAG AA.
 */
export const STAGE_TONES = ['klein', 'sky', 'ok', 'warn', 'err', 'gray'] as const;
export type StageTone = (typeof STAGE_TONES)[number];

/** What a stage counts as: still open, won or lost. */
export const STAGE_KINDS = ['open', 'won', 'lost'] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

export const MIN_STAGES = 2;
export const MAX_STAGES = 10;
export const MAX_STAGE_LABEL = 40;

/** Who a new lead goes to (owner item O-9: manual by default). */
export const ASSIGNMENT_RULES = ['manual', 'round_robin', 'fixed'] as const;
export type AssignmentRule = (typeof ASSIGNMENT_RULES)[number];
export const MAX_ASSIGNMENT_POOL = 20;

export const MIN_SLA_HOURS = 1;
export const MAX_SLA_HOURS = 168;
export const MAX_SIGNAL_POINTS = 50;

const unique = (list: readonly string[]) => new Set(list).size === list.length;

/** One stage as the screen sends it: an id for a stage that exists, none for a new one. */
export const LeadStageInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    label: z.string().trim().min(1).max(MAX_STAGE_LABEL),
    tone: z.enum(STAGE_TONES),
    kind: z.enum(STAGE_KINDS),
  })
  .strict();
export type LeadStageInput = z.infer<typeof LeadStageInputSchema>;

/**
 * PUT /api/admin/crm/stages: the whole pipeline in board order, and the stages as the screen
 * loaded them (`known`, id and version each): the save is refused if anything changed since.
 * The initial stage stays, first; the database checks that it is the initial one.
 */
export const LeadStagesSaveSchema = z
  .object({
    known: z
      .array(z.object({ id: z.string().uuid(), version: z.number().int().min(1) }).strict())
      .min(MIN_STAGES)
      .max(MAX_STAGES),
    stages: z.array(LeadStageInputSchema).min(MIN_STAGES).max(MAX_STAGES),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = value.stages.flatMap((s) => (s.id ? [s.id] : []));
    if (!unique(ids)) ctx.addIssue({ code: 'custom', path: ['stages'], message: 'a stage twice' });
    if (!value.stages[0]?.id) {
      ctx.addIssue({ code: 'custom', path: ['stages', 0], message: 'the first stage stays first' });
    }
    if (!value.stages.some((s) => s.kind === 'won')) {
      ctx.addIssue({ code: 'custom', path: ['stages'], message: 'a pipeline needs a won stage' });
    }
    if (!value.stages.some((s) => s.kind === 'lost')) {
      ctx.addIssue({ code: 'custom', path: ['stages'], message: 'a pipeline needs a lost stage' });
    }
  });
export type LeadStagesSave = z.infer<typeof LeadStagesSaveSchema>;

/** Every signal's points: the whole closed set, 0 to 50 each (the CHECK, app.crm_scoring_ok). */
export const CrmScoringSaveSchema = z
  .object(
    Object.fromEntries(
      SCORE_SIGNALS.map((s) => [s, z.number().int().min(0).max(MAX_SIGNAL_POINTS)]),
    ) as Record<ScoreSignal, z.ZodNumber>,
  )
  .strict();

export const CrmAssignmentSchema = z
  .object({
    rule: z.enum(ASSIGNMENT_RULES),
    pool: z.array(z.string().uuid()).max(MAX_ASSIGNMENT_POOL).refine(unique, 'a person twice'),
    fixedTo: z.string().uuid().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.rule === 'fixed' && !value.fixedTo) {
      ctx.addIssue({ code: 'custom', path: ['fixedTo'], message: 'choose the person' });
    }
    if (value.rule === 'round_robin' && value.pool.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['pool'], message: 'choose at least one person' });
    }
  });
export type CrmAssignment = z.infer<typeof CrmAssignmentSchema>;

/**
 * PUT /api/admin/crm/settings: one card's change at the version the screen read. Each card
 * sends its own part; the time zone is not here (site_profile owns it, the plan's B7.5).
 */
export const CrmSettingsSaveSchema = z
  .object({
    version: z.number().int().min(1),
    scoring: CrmScoringSaveSchema.optional(),
    slaHours: z.number().int().min(MIN_SLA_HOURS).max(MAX_SLA_HOURS).optional(),
    assignment: CrmAssignmentSchema.optional(),
  })
  .strict()
  .refine(
    (v) => v.scoring !== undefined || v.slaHours !== undefined || v.assignment !== undefined,
    'nothing to save',
  );
export type CrmSettingsSave = z.infer<typeof CrmSettingsSaveSchema>;
