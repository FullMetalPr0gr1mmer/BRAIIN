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
// `leads.pii` gates: budget · timeline · internal_notes · ip_inet — the exact four
// columns CLAUDE.md §3 restricts to Admin + Developer. Content Creator and SEO hold
// neither `leads.manage` nor `leads.pii`, so they get nothing at all. "timeline" is two
// columns since migration 0017: the legacy `timeline_band` select value and the encrypted
// free-text deadline the v2 contact form collects (`timeline_text_enc`).
//
// Since migration 0033 the database holds the same line. A staff token can SELECT only
// SAFE_LEAD_COLUMNS (plus tenant_id): the caller's own client (`sb`) asking for any other
// lead column gets a permission error, whatever the role. The gated columns are read as
// the service role, by the two audited paths only: the per-lead reveal
// (src/pages/api/admin/leads/[id].ts) and the CSV export (export.ts).

export const SENSITIVE_LEAD_COLUMNS = [
  'budget_enc',
  'timeline_band',
  'timeline_text_enc',
  'internal_notes',
  'ip_inet',
] as const;

/**
 * Columns safe for any role that can see leads at all (mirrors the leads_safe view).
 * `discipline_of_interest` (0028) is the "{Discipline}, help me choose" answer — not
 * sensitive, the view's last column.
 */
export const SAFE_LEAD_COLUMNS =
  'id,kind,locale,name,company,message,service_of_interest,status,consent_marketing,created_at,updated_at,discipline_of_interest';

/**
 * The ciphertext and the gated columns. `authenticated` cannot read any of them (0033):
 * only the service role can, after assertCap, a live recheck and a fail-closed audit row.
 */
export const GATED_LEAD_COLUMNS =
  'email_enc,phone_enc,budget_enc,timeline_band,timeline_text_enc,internal_notes,ip_inet';

/** Safe columns plus the gated ones: the PII export's projection, read as the service role. */
export const FULL_LEAD_COLUMNS = `${SAFE_LEAD_COLUMNS},${GATED_LEAD_COLUMNS}`;

export function canSeeLeadPii(role: Role): boolean {
  return can(role, 'leads.pii') === 'full';
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
  delete out['email_enc'];
  delete out['phone_enc'];
  return out as Partial<T>;
}
