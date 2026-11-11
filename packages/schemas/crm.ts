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

/**
 * What a PATCH or an export link that still sends the legacy status is told (C10a: 0097
 * withdrew the column's grant; C14a: the export stopped filtering on it; C14b drops it).
 */
export const STATUS_IS_A_STAGE = 'A lead moves by its stage now. Choose a stage instead.';

/**
 * PATCH /api/admin/leads/[id]. The pipeline fields need the `version` the caller read (a
 * 409 when it moved on); a star, a read mark and a logged contact do not, because they
 * never move it.
 *
 * `status` is refused (C10a): migration 0097 withdrew the staff UPDATE on the legacy column,
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
 *
 * `status` is refused (C14a), as the PATCH refuses it: the legacy column is the contract's to
 * drop (C14b), so the export no longer filters on it. A link that still carries it (one saved
 * from the legacy panel) is told to choose a stage, rather than exporting more than it asked
 * for. The key stays known so the 422 names it.
 */
export const LeadExportQuerySchema = z
  .object({
    from: Instant.optional(),
    to: Instant.optional(),
    status: z.unknown().optional(),
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
  .strict()
  .refine((query) => query.status === undefined, {
    message: STATUS_IS_A_STAGE,
    path: ['status'],
  });
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

// ── Custom contact fields (Admin v2 C9b) ─────────────────────────────────────────────────────
// The definitions live in crm_settings.custom_fields (crm.settings edits them); the values in
// crm_contacts.custom. The database holds both again: app.crm_custom_fields_ok (the CHECK) and
// app.tg_crm_contact_custom (each new or changed value), in the C9b migration;
// tests/lib/crmCustomFields.spec.ts parses it and compares.

/** A custom field's kinds (crm.md §4.7 and the prototype: text, number, date). */
export const CUSTOM_FIELD_TYPES = ['text', 'number', 'date'] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];
export const MAX_CUSTOM_FIELDS = 12;
export const MAX_CUSTOM_FIELD_LABEL = 60;
export const MAX_CUSTOM_TEXT = 500;
/** A number field holds at most 10^15 either way (the database's bound). */
export const MAX_CUSTOM_NUMBER = 1e15;
export const CUSTOM_FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * Custom field values: a key per field the CRM settings define, each a short text, a number,
 * or null (empty). Checked against the definitions in the Worker
 * (src/lib/crm/contactCustom.ts) and the database; an unknown key is refused in both.
 */
export const ContactCustomSchema = z.record(
  z.string().regex(CUSTOM_FIELD_KEY),
  z.union([z.string().max(MAX_CUSTOM_TEXT), z.number().finite(), z.null()]),
);
export type ContactCustom = z.infer<typeof ContactCustomSchema>;

/** One custom field as crm_settings.custom_fields holds it: exactly these three keys. */
export const CustomFieldDefinitionSchema = z
  .object({
    key: z.string().regex(CUSTOM_FIELD_KEY, 'lower-case letters, digits and _, a letter first'),
    label: z
      .string()
      .trim()
      .min(1)
      .max(MAX_CUSTOM_FIELD_LABEL)
      .refine((v) => !CONTROL.test(v), 'no control characters'),
    type: z.enum(CUSTOM_FIELD_TYPES),
  })
  .strict();
export type CustomFieldDefinition = z.infer<typeof CustomFieldDefinitionSchema>;

/** The whole set a save writes, in the order the screen shows it: at most 12, each key once. */
export const CustomFieldsSaveSchema = z
  .array(CustomFieldDefinitionSchema)
  .max(MAX_CUSTOM_FIELDS)
  .refine((fields) => new Set(fields.map((f) => f.key)).size === fields.length, {
    message: 'each key once',
  });

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
    // C9b: the custom contact fields' definitions, the whole set.
    customFields: CustomFieldsSaveSchema.optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.scoring !== undefined ||
      v.slaHours !== undefined ||
      v.assignment !== undefined ||
      v.customFields !== undefined,
    'nothing to save',
  );
export type CrmSettingsSave = z.infer<typeof CrmSettingsSaveSchema>;

// ── Contacts (Admin v2 C6) ──────────────────────────────────────────────────────────────────
// The contacts API's shapes. The database checks them again: the column CHECKs of C5's
// crm_contacts (0131), the filter's allow-list (app.crm_contact_filter, 0133) and the doors'
// own validation; two layers, and a 22023 or 23514 for anything outside them.

/** A contact's relationship stage (crm_contacts.stage). */
export const CONTACT_STAGES = ['lead', 'client', 'past', 'partner'] as const;
export type ContactStage = (typeof CONTACT_STAGES)[number];

/** How the person found us (crm_contacts.source). `import` is the importer's alone (C15). */
export const CONTACT_SOURCES = [
  'web_form',
  'manual',
  'referral',
  'instagram',
  'event',
  'google',
  'linkedin',
  'direct',
  'whatsapp',
  'import',
] as const;
export type ContactSource = (typeof CONTACT_SOURCES)[number];
/** The sources a person may choose (never `import`). */
export const CONTACT_CHOSEN_SOURCES = [
  'web_form',
  'manual',
  'referral',
  'instagram',
  'event',
  'google',
  'linkedin',
  'direct',
  'whatsapp',
] as const satisfies readonly ContactSource[];

/** The People list's orders: the most recently active first is the default. */
export const CONTACT_SORTS = ['recent', 'name', 'starred', 'oldest'] as const;

/** Text a person types: trimmed, no control characters (the columns' CHECKs refuse them). */
const plainText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !CONTROL.test(v), 'no control characters');

/** POST /api/admin/crm/contacts/query: the list's filter, its search in a body (D10). */
export const ContactQuerySchema = z
  .object({
    stage: z.enum(CONTACT_STAGES).optional(),
    owner: LeadAssignedFilterSchema.optional(),
    starred: z.boolean().optional(),
    expiring: z.boolean().optional(),
    tag: LeadTagSchema.optional(),
    q: z.string().max(64).optional(),
    sort: z.enum(CONTACT_SORTS).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).max(10000).optional(),
  })
  .strict();
export type ContactQuery = z.infer<typeof ContactQuerySchema>;

/** POST /api/admin/crm/contacts/summary takes nothing. */
export const ContactSummaryQuerySchema = z.object({}).strict();

/** POST /api/admin/crm/contacts/lookup: a picker's search, at most 8 answers. */
export const ContactLookupSchema = z.object({ q: z.string().trim().min(1).max(64) }).strict();

/** An e-mail or phone a person types for a contact. The Worker encrypts and indexes it. */
export const ContactChannelInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('email'),
      value: z.string().trim().email().max(254),
      isPrimary: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('phone'),
      value: z.string().trim().min(3).max(32),
      isPrimary: z.boolean().optional(),
    })
    .strict(),
]);
export type ContactChannelInput = z.infer<typeof ContactChannelInputSchema>;

const ChannelsAddSchema = z.array(ContactChannelInputSchema).max(10);

const CountrySchema = z.string().regex(/^[A-Z]{2}$/, 'a two-letter country code');

/** The details a person writes, shared by the add and the edit. */
const contactDetails = {
  displayName: plainText(120),
  title: plainText(120).nullable(),
  companyName: plainText(120).nullable(),
  stage: z.enum(CONTACT_STAGES),
  source: z.enum(CONTACT_CHOSEN_SOURCES),
  ownerId: z.string().uuid().nullable(),
  locale: z.enum(['en', 'ar']),
  city: plainText(80).nullable(),
  country: CountrySchema.nullable(),
  tags: LeadTagsSchema,
  custom: ContactCustomSchema,
};

/** POST /api/admin/crm/contacts: a contact added by hand, with its e-mails and phones. */
export const ContactCreateSchema = z
  .object({
    displayName: contactDetails.displayName,
    title: contactDetails.title.optional(),
    companyName: contactDetails.companyName.optional(),
    stage: contactDetails.stage.optional(),
    source: contactDetails.source.optional(),
    ownerId: contactDetails.ownerId.optional(),
    locale: contactDetails.locale.optional(),
    city: contactDetails.city.optional(),
    country: contactDetails.country.optional(),
    tags: contactDetails.tags.optional(),
    custom: contactDetails.custom.optional(),
    channels: ChannelsAddSchema.optional(),
  })
  .strict();
export type ContactCreate = z.infer<typeof ContactCreateSchema>;

/** The PATCH fields that need the version the caller read. */
export const VERSIONED_CONTACT_FIELDS = [
  'displayName',
  'title',
  'companyName',
  'stage',
  'source',
  'ownerId',
  'locale',
  'city',
  'country',
  'tags',
  'custom',
  'channels',
] as const;

/**
 * PATCH /api/admin/crm/contacts/[id]. The details and the channels need the version the
 * caller read (a 409 when it moved on); a star does not, as it never moves it. A channel
 * change (add, remove, make primary) is checked at that version and does not move it.
 */
export const ContactPatchSchema = z
  .object({
    version: z.number().int().min(1).optional(),
    displayName: contactDetails.displayName.optional(),
    title: contactDetails.title.optional(),
    companyName: contactDetails.companyName.optional(),
    stage: contactDetails.stage.optional(),
    source: contactDetails.source.optional(),
    ownerId: contactDetails.ownerId.optional(),
    locale: contactDetails.locale.optional(),
    city: contactDetails.city.optional(),
    country: contactDetails.country.optional(),
    tags: contactDetails.tags.optional(),
    custom: contactDetails.custom.optional(),
    isStarred: z.boolean().optional(),
    channels: z
      .object({
        add: ChannelsAddSchema.optional(),
        remove: z.array(z.string().uuid()).max(10).optional(),
        primary: z.array(z.string().uuid()).max(2).optional(),
      })
      .strict()
      .refine(
        (c) => (c.add?.length ?? 0) + (c.remove?.length ?? 0) + (c.primary?.length ?? 0) > 0,
        'nothing to change',
      )
      .optional(),
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
      VERSIONED_CONTACT_FIELDS.every((field) => patch[field] === undefined),
    { message: 'send the version you read with a change to the details', path: ['version'] },
  );
export type ContactPatch = z.infer<typeof ContactPatchSchema>;

const ContactBulkItemsSchema = z
  .array(z.object({ id: z.string().uuid(), version: z.number().int().min(1).optional() }).strict())
  .min(1)
  .max(100)
  .refine((items) => new Set(items.map((i) => i.id.toLowerCase())).size === items.length, {
    message: 'each contact once',
  });
const VersionedContactItemsSchema = ContactBulkItemsSchema.refine(
  (items) => items.every((item) => item.version !== undefined),
  { message: 'this action needs the version of each contact' },
);

/** POST /api/admin/crm/contacts/bulk: one action over up to 100 contacts. No bulk delete. */
export const ContactBulkSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('tagAdd'),
      value: LeadTagSchema,
      items: VersionedContactItemsSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('tagRemove'),
      value: LeadTagSchema,
      items: VersionedContactItemsSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('owner'),
      value: z.string().uuid().nullable(),
      items: VersionedContactItemsSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('stage'),
      value: z.enum(CONTACT_STAGES),
      items: VersionedContactItemsSchema,
    })
    .strict(),
  z
    .object({ action: z.literal('star'), value: z.boolean(), items: ContactBulkItemsSchema })
    .strict(),
]);
export type ContactBulk = z.infer<typeof ContactBulkSchema>;
export type ContactBulkAction = ContactBulk['action'];

/** A note on a contact: as a lead's, 1 to 5,000 characters, append-only. */
export const ContactNoteInputSchema = LeadNoteInputSchema;

/** GET /api/admin/crm/contacts/[id]/timeline: a filter and the last event shown. */
export const CONTACT_TIMELINE_KINDS = ['all', 'notes', 'leads', 'changes'] as const;
export const ContactTimelineQuerySchema = z
  .object({
    kind: z.enum(CONTACT_TIMELINE_KINDS).optional(),
    before: Instant.optional(),
    beforeSrc: z.enum(['contact', 'lead']).optional(),
    beforeId: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(60).optional(),
  })
  .strict()
  .refine(
    (page) =>
      (page.before === undefined) === (page.beforeSrc === undefined) &&
      (page.before === undefined) === (page.beforeId === undefined),
    { message: 'before, beforeSrc and beforeId go together', path: ['beforeId'] },
  );
export type ContactTimelineQuery = z.infer<typeof ContactTimelineQuerySchema>;

/**
 * POST /api/admin/crm/contacts/[id]/links: the check of a lead matched to this contact by
 * phone alone. `confirm`: it is this person. `detach`: it is not.
 */
export const ContactLinkSchema = z
  .object({ leadId: z.string().uuid(), action: z.enum(['confirm', 'detach']) })
  .strict();

/**
 * POST /api/admin/crm/contacts/[id]/leads: a new lead for this contact. Its e-mail and phone
 * are the contact's own, copied by the database; the request carries none.
 */
export const ContactNewLeadSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    company: z.string().trim().min(1).max(120).optional(),
    serviceOfInterest: SlugSchema.optional(),
    budgetBand: BudgetBandSchema.optional(),
    timeline: z.string().trim().min(1).max(120).optional(),
    message: z.string().trim().min(1).max(5000),
    locale: z.enum(['en', 'ar']).optional(),
    channel: z.enum(MANUAL_LEAD_CHANNELS),
  })
  .strict();
export type ContactNewLead = z.infer<typeof ContactNewLeadSchema>;

/**
 * POST /api/admin/crm/contacts/[id]/erase: why, and the phone matches the Admin ticked in the
 * preview (each must be one of them, or the database refuses the whole erasure).
 */
export const ContactEraseSchema = z
  .object({
    reason: z.enum(['dsar', 'decision']),
    extraLeads: z
      .array(z.string().uuid())
      .max(100)
      .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, 'each once')
      .optional(),
  })
  .strict();
