import type { Role } from '@/lib/auth/types';
import { can } from '@/lib/authz/matrix';

// Which columns of `job_applications` each admin read projects (migration 0029).
//
// The table is Admin-only in BOTH server layers (RLS + assertCap, owner decision J6), so the
// split here is not about roles — it is about what a read DISCLOSES and therefore audits:
//   • the list and the detail never carry the contact details or the CV's storage path;
//   • the contact details are ciphertext, decrypted one application at a time behind
//     `applications.pii`, live-rechecked and audited before the plaintext leaves;
//   • the storage path never leaves the server at all — the download route reads it and
//     streams the file.

export const LIST_APPLICATION_COLUMNS =
  'id,created_at,updated_at,locale,name,city,role,experience,work_type,availability,skills,' +
  'portfolio_url,linkedin_url,status,future_roles_consent,retention_delete_after,cv_content_type,cv_bytes';

export const DETAIL_APPLICATION_COLUMNS = `${LIST_APPLICATION_COLUMNS},message,internal_notes,consent_at,consent_version`;

export const PII_APPLICATION_COLUMNS = `${DETAIL_APPLICATION_COLUMNS},email_enc,phone_enc`;

export const canManageApplications = (role: Role) => can(role, 'applications.manage') === 'full';
export const canSeeApplicantPii = (role: Role) => can(role, 'applications.pii') === 'full';

/** Drops anything that must not reach the browser (belt: the projections already omit it). */
export function toAdminApplication(row: Record<string, unknown>): Record<string, unknown> {
  const { email_enc: _e, phone_enc: _p, cv_path: _c, tenant_id: _t, ...rest } = row;
  return { ...rest, has_cv: typeof row['cv_bytes'] === 'number' };
}
