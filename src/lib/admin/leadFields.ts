import type { Role } from '@/lib/auth/types';
import { can } from '@/lib/authz/matrix';

// THE shared field-visibility helper (CLAUDE.md §10). One definition of "which lead
// fields may this role see", used by the admin API, the CSV export, and the lead
// notification path.
//
// It is shared for a specific reason: the notification email and the admin table are
// written by different people at different times, and the failure mode of them
// disagreeing is that budget and internal notes get emailed to someone the CMS itself
// refuses to show them to. The rule has to have one home.
//
// `leads.pii` gates: budget · timeline (and the contact ciphertext), the columns CLAUDE.md §3
// restricts to Admin + Developer, and to Sales one lead at a time. Content Creator and SEO hold
// neither `leads.manage` nor `leads.pii`, so they get nothing at all. The timeline is the
// encrypted free-text deadline (`timeline_text_enc`, 0017); a legacy band was moved into it by
// the daily cron (0035).
//
// Since Admin v2 C14a no query names the legacy columns the contract slice drops (C14b): every
// projection below names only columns that exist before and after that migration, so the
// Worker runs on both schemas. LEGACY_LEAD_COLUMNS names them once, for stripSensitive and the
// tests, never for a query; tests/lib/leadsContract.spec.ts holds that line.
//
// Since migration 0033 the database holds the same line. A staff token can SELECT only
// SAFE_LEAD_COLUMNS (plus tenant_id): the caller's own client (`sb`) asking for any other
// lead column gets a permission error, whatever the role. The gated columns are read as
// the service role, and only two audited paths return them to a person: the per-lead
// reveal (src/lib/crm/reveal.ts, behind the CRM's POST /api/admin/leads/[id]/reveal) and the
// CSV export (export.ts). Two server-side processes read them and return nothing: the signed
// notify-lead hook, which stores field names only, and the daily index cron
// (src/lib/crm/indexBackfill.ts), which keeps HMACs and signal names.
// tests/lib/leadGrants.spec.ts names every reader.

export const SENSITIVE_LEAD_COLUMNS = ['budget_enc', 'timeline_text_enc'] as const;

/**
 * The legacy lead columns the contract slice drops (C14b): the old status, the old notes field,
 * the never-written address and the old plaintext band. No query names them since C14a (a lead
 * moves by its stage, the notes are the audited thread, the band is in the encrypted
 * timeline). Listed here only so stripSensitive keeps them out of a response while today's
 * schema still holds them, and so the tests know what C14b removes.
 */
export const LEGACY_LEAD_COLUMNS = [
  'status',
  'internal_notes',
  'ip_inet',
  'timeline_band',
] as const;

/**
 * Columns safe for any role that can see leads at all (the leads_safe view's first columns,
 * less the legacy `status` the contract slice drops: a lead moves by its stage, C14a).
 * `discipline_of_interest` (0028) is the "{Discipline}, help me choose" answer — not
 * sensitive.
 */
export const SAFE_LEAD_COLUMNS =
  'id,kind,locale,name,company,message,service_of_interest,consent_marketing,created_at,updated_at,discipline_of_interest';

/**
 * The ciphertext and the gated columns. `authenticated` cannot read any of them (0033):
 * only the service role can. A person sees them only after assertCap, a live recheck and a
 * fail-closed audit row (the reveal and the export). `score_signals` (0035) joined in C4a:
 * the score's reasons, three of which (budget_given, budget_200k_plus, timeline_given)
 * disclose the budget band and the timeline, so they leave only through the audited reveal,
 * named in its audit row (decision D7). The export does not carry them.
 */
export const GATED_LEAD_COLUMNS = 'email_enc,phone_enc,budget_enc,timeline_text_enc,score_signals';

/**
 * The pipeline's columns (0034 to 0041): readable by every lead worker, none of them
 * personal data beyond what the safe columns already hold (ids, numbers, flags, stamps).
 */
export const PIPELINE_LEAD_COLUMNS =
  'lead_number,stage_id,is_spam,first_response_at,won_at,version,score,source,channel,assigned_to,value_sar,is_starred,read_at,read_by,tags,last_contact_at,last_contact_channel';

/** What a lead write answers with (Admin v2 C3): the safe columns and the pipeline's. */
export const LEAD_WRITE_COLUMNS = `${SAFE_LEAD_COLUMNS},${PIPELINE_LEAD_COLUMNS}`;

/** Safe columns plus the gated ones: the PII export's projection, read as the service role. */
export const FULL_LEAD_COLUMNS = `${SAFE_LEAD_COLUMNS},${GATED_LEAD_COLUMNS}`;

export function canSeeLeadPii(role: Role): boolean {
  return can(role, 'leads.pii') === 'full';
}

/**
 * May this role be handed lead PII it did not ask for, one lead at a time? Only a holder of
 * `leads.pii` that also holds `export.csv` (Admin, Developer): those roles may take every
 * lead's details at once anyway. Sales holds `leads.pii` one lead at a time (owner default
 * O-6), so it sees a lead's details only through the reveal, which is live-rechecked,
 * rate-limited and audited first; a notification never carries them to it (Admin v2 C10a).
 */
export function receivesLeadPiiUnasked(role: Role): boolean {
  return canSeeLeadPii(role) && can(role, 'export.csv') === 'full';
}

export function canManageLeads(role: Role): boolean {
  return can(role, 'leads.manage') === 'full';
}

/**
 * Strips sensitive keys from an outbound lead object.
 *
 * Defence in depth behind the projection and the column grant: SAFE_LEAD_COLUMNS is what
 * keeps these out of the result set, 0033 is what refuses them to the caller's client,
 * and this is what keeps them out of the RESPONSE if a service-role row is ever passed
 * through by mistake.
 */
export function stripSensitive<T extends Record<string, unknown>>(row: T): Partial<T> {
  const out: Record<string, unknown> = { ...row };
  for (const column of SENSITIVE_LEAD_COLUMNS) delete out[column];
  for (const column of LEGACY_LEAD_COLUMNS) delete out[column];
  delete out['email_enc'];
  delete out['phone_enc'];
  delete out['score_signals'];
  return out as Partial<T>;
}
