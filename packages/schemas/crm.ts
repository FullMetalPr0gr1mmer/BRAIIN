import { z } from 'zod';

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
