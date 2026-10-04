import { z } from 'zod';

// The CRM's closed vocabularies (Admin v2, docs/admin-v2/crm.md §4 and §6.3). The SQL
// CHECKs in supabase/migrations/0035_crm_ingest.sql carry the same lists; a test parses
// the migration and compares (tests/schemas/crm.spec.ts).

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
