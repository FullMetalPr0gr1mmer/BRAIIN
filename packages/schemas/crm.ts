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

// ---- Reading the pipeline (Admin v2 C2a) --------------------------------------------------
// The filter the lead list, board and summary accept. The database validates it again
// (app.lead_filter, migration 0036): two layers, and a 22023 for anything outside them.

const Instant = z.string().datetime({ offset: true });

export const LeadQuerySchema = z
  .object({
    stage: z.string().uuid().optional(),
    spam: z.boolean().optional(),
    q: z.string().max(64).optional(),
    from: Instant.optional(),
    to: Instant.optional(),
    sort: z.enum(['newest', 'oldest', 'score']).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).max(10000).optional(),
  })
  .strict();
export type LeadQuery = z.infer<typeof LeadQuerySchema>;

/** The board shows every stage and no spam, so it takes no stage, spam flag or page. */
export const LeadBoardQuerySchema = z
  .object({
    q: z.string().max(64).optional(),
    from: Instant.optional(),
    to: Instant.optional(),
    perStage: z.number().int().min(1).max(50).optional(),
  })
  .strict();
export type LeadBoardQuery = z.infer<typeof LeadBoardQuerySchema>;

/** The KPIs take a date range and nothing else. */
export const LeadSummaryQuerySchema = z
  .object({ from: Instant.optional(), to: Instant.optional() })
  .strict();

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

/** The legacy panel's status, accepted until C4 moves it to the pipeline (C14 drops it). */
const LegacyLeadStatusSchema = z.enum(['new', 'in_progress', 'done', 'spam']);

/** The PATCH fields that move a lead's version, so they need the version the caller read. */
export const VERSIONED_LEAD_FIELDS = [
  'stageId',
  'isSpam',
  'assignedTo',
  'valueSar',
  'tags',
] as const;

/**
 * PATCH /api/admin/leads/[id]. The pipeline fields need the `version` the caller read (a
 * 409 when it moved on); a star, a read mark and a logged contact do not, because they
 * never move it. `status` and `internalNotes` are the legacy panel's (the expand window:
 * C4 moves the panel to the pipeline and the notes thread), and a legacy status cannot be
 * sent with a stage or a spam flag, which it would contradict.
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
    status: LegacyLeadStatusSchema.optional(),
    internalNotes: z.string().max(5000).nullish(),
  })
  .strict()
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
  )
  .refine(
    (patch) =>
      patch.status === undefined || (patch.stageId === undefined && patch.isSpam === undefined),
    { message: 'a legacy status cannot be sent with a stage or a spam flag', path: ['status'] },
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
  })
  .strict();
export type LeadExportQuery = z.infer<typeof LeadExportQuerySchema>;
