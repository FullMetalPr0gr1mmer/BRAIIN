import type { SupabaseClient } from '@supabase/supabase-js';
import {
  APPLICATION_RETENTION_MONTHS,
  CV_KINDS,
  type ApplicationInput,
  type CvKind,
} from '@schemas/application';
import { encryptPII } from '@/lib/crypto/pii';
import { APPLICANT_PII_LABEL, labelledKeyMaterial } from './keys';
import { cvObjectPath, removeCvs, uploadCv } from './storage';

// Writes one application: the CV object first, then the row; if the row fails, the object
// is deleted again (a compensating delete), so a failure never leaves an orphaned CV that
// no row — and so no retention job — knows about.
//
// The caller has already: checked origin, size, the open flag, the limits, the honeypot,
// the schema, and sniffed the CV. This function decides nothing about the visitor.

export type CreateApplicationResult =
  { ok: true; id: string } | { ok: false; reason: 'upload-failed' | 'insert-failed' };

/** now + n months, in UTC. */
export function monthsFrom(now: Date, months: number): Date {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

export async function createApplication(
  svc: SupabaseClient,
  tenantId: string,
  input: ApplicationInput,
  cv: { file: Blob; kind: CvKind } | null,
  rootKey: string,
  now: Date = new Date(),
): Promise<CreateApplicationResult> {
  const id = crypto.randomUUID();
  const path = cv ? cvObjectPath(tenantId, id, cv.kind) : null;

  if (cv && path && !(await uploadCv(svc, path, cv.file, cv.kind))) {
    return { ok: false, reason: 'upload-failed' };
  }

  const key = labelledKeyMaterial(rootKey, APPLICANT_PII_LABEL);
  const [email_enc, phone_enc] = await Promise.all([
    encryptPII(input.email, key),
    encryptPII(input.phone, key),
  ]);
  const months = input.consentFutureRoles
    ? APPLICATION_RETENTION_MONTHS.futureRoles
    : APPLICATION_RETENTION_MONTHS.application;

  const { error } = await svc.from('job_applications').insert({
    id,
    tenant_id: tenantId,
    locale: input.locale,
    name: input.name,
    email_enc,
    phone_enc,
    city: input.city,
    role: input.role,
    experience: input.experience,
    work_type: input.workType,
    availability: input.availability,
    skills: input.skills,
    portfolio_url: input.portfolio,
    linkedin_url: input.linkedin ?? null,
    message: input.message,
    cv_path: path,
    cv_content_type: cv ? CV_KINDS[cv.kind].contentType : null,
    cv_bytes: cv ? cv.file.size : null,
    consent_at: now.toISOString(),
    consent_version: input.policyVersion,
    future_roles_consent: input.consentFutureRoles,
    retention_delete_after: monthsFrom(now, months).toISOString(),
  });

  if (error) {
    if (path) await removeCvs(svc, [path]);
    return { ok: false, reason: 'insert-failed' };
  }
  return { ok: true, id };
}
