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

// Writes one application: everything that can fail without touching Storage first (the
// encryption, building the row), then the CV object, then the row; if the row fails, the
// object is deleted again (a compensating delete). So the ONLY step between an upload and
// its row is the insert. What even that cannot cover — the Worker stopped between the two, or the
// compensating delete failing too — the daily job's orphan sweep removes
// (`application_orphan_cvs()`, src/lib/applications/retention.ts).
//
// The caller has already: checked origin, size, the open flag, the limits, the honeypot,
// the schema, and sniffed the CV. This function decides nothing about the visitor.

export type CreateApplicationResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'encrypt-failed' | 'upload-failed' | 'insert-failed' };

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

  let email_enc: string;
  let phone_enc: string;
  try {
    const key = labelledKeyMaterial(rootKey, APPLICANT_PII_LABEL);
    [email_enc, phone_enc] = await Promise.all([
      encryptPII(input.email, key),
      encryptPII(input.phone, key),
    ]);
  } catch {
    return { ok: false, reason: 'encrypt-failed' };
  }
  const months = input.consentFutureRoles
    ? APPLICATION_RETENTION_MONTHS.futureRoles
    : APPLICATION_RETENTION_MONTHS.application;

  const row = {
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
  };

  if (cv && path && !(await uploadCv(svc, path, cv.file, cv.kind))) {
    return { ok: false, reason: 'upload-failed' };
  }

  let inserted = false;
  try {
    const { error } = await svc.from('job_applications').insert(row);
    inserted = !error;
  } catch {
    inserted = false;
  }
  if (!inserted) {
    if (path) await removeCvs(svc, [path]);
    return { ok: false, reason: 'insert-failed' };
  }
  return { ok: true, id };
}
