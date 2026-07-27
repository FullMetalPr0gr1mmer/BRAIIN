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
// neither `leads.manage` nor `leads.pii`, so they get nothing at all.

export const SENSITIVE_LEAD_COLUMNS = [
  'budget_enc',
  'timeline_band',
  'internal_notes',
  'ip_inet',
] as const;

/** Columns safe for any role that can see leads at all (mirrors the leads_safe view). */
export const SAFE_LEAD_COLUMNS =
  'id,kind,locale,name,message,service_of_interest,status,consent_marketing,created_at,updated_at';

/** Safe columns plus the ciphertext/sensitive ones. Only for `leads.pii` holders. */
export const FULL_LEAD_COLUMNS = `${SAFE_LEAD_COLUMNS},email_enc,phone_enc,budget_enc,timeline_band,internal_notes,ip_inet`;

export function canSeeLeadPii(role: Role): boolean {
  return can(role, 'leads.pii') === 'full';
}

export function canManageLeads(role: Role): boolean {
  return can(role, 'leads.manage') === 'full';
}

/** Column list for a role — the projection, decided in one place. */
export function leadColumnsFor(role: Role): string {
  return canSeeLeadPii(role) ? FULL_LEAD_COLUMNS : SAFE_LEAD_COLUMNS;
}

/**
 * Strips sensitive keys from an outbound lead object.
 *
 * Defence in depth behind `leadColumnsFor`: the projection above is what should keep
 * these out of the result set, and this is what keeps them out of the RESPONSE if some
 * future caller passes `select('*')`. Both are cheap; only one of them is load-bearing
 * on any given day, and it is not always the same one.
 */
export function stripSensitive<T extends Record<string, unknown>>(row: T): Partial<T> {
  const out: Record<string, unknown> = { ...row };
  for (const column of SENSITIVE_LEAD_COLUMNS) delete out[column];
  delete out['email_enc'];
  delete out['phone_enc'];
  return out as Partial<T>;
}
