import { z } from 'zod';
import { LEAD_PII_ENC_KEY } from 'astro:env/server';
import { ApplicationUpdateSchema } from '@schemas/application';
import { defineAdminRoute } from '@/lib/admin/route';
import { NotFoundError, ValidationError } from '@/lib/admin/errors';
import { AuthorizationError } from '@/lib/authz/errors';
import { getRow } from '@/lib/admin/crud';
import { writeAudit } from '@/lib/admin/audit';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { decryptPII } from '@/lib/crypto/pii';
import { serviceClient } from '@/lib/supabase/server';
import { APPLICANT_PII_LABEL, labelledKeyMaterial } from '@/lib/applications/keys';
import { removeCvs } from '@/lib/applications/storage';
import {
  DETAIL_APPLICATION_COLUMNS,
  PII_APPLICATION_COLUMNS,
  canSeeApplicantPii,
  toAdminApplication,
} from '@/lib/admin/applicationFields';

// One job application (Join). Admin only — RLS (`job_applications_admin_all` + the
// RESTRICTIVE `job_applications_admin_only`, 0029) and assertCap both.
//
//   GET          the application; `?pii=1` adds the decrypted e-mail and phone
//                (`applications.pii`), live-rechecked and audited BEFORE the plaintext is
//                produced — and if the audit row cannot be written, nothing is decrypted.
//   PATCH        status / internal notes (the only columns the 0029 grant lets staff change).
//   DELETE       erase (DSAR): the CV object first, then the row; audited before either.

export const prerender = false;

function requireId(params: Record<string, string | undefined>): string {
  const id = params['id'];
  if (!id || !z.string().uuid().safeParse(id).success) throw new NotFoundError('application');
  return id;
}

export const GET = defineAdminRoute({
  cap: 'applications.manage',
  handler: async ({ auth, sb, url, params, audit }) => {
    const id = requireId(params);
    const wantsPii = url.searchParams.get('pii') === '1' && canSeeApplicantPii(auth.role);

    if (!wantsPii) {
      const row = await getRow<Record<string, unknown>>(
        sb,
        'job_applications',
        auth,
        id,
        DETAIL_APPLICATION_COLUMNS,
      );
      audit({
        action: 'application.view',
        entityType: 'application',
        entityId: id,
        detail: { pii: false },
      });
      return toAdminApplication(row);
    }

    await liveRecheck(auth);
    const row = await getRow<Record<string, unknown>>(
      sb,
      'job_applications',
      auth,
      id,
      PII_APPLICATION_COLUMNS,
    );
    // Fail closed: an unlogged read of an applicant's phone number is the one outcome PDPL
    // accountability cannot accept (the queued audit of the kernel may fail silently).
    const logged = await writeAudit(sb, auth, {
      action: 'application.view_pii',
      entityType: 'application',
      entityId: id,
      detail: { pii: true, fields: ['email', 'phone'] },
    });
    if (!logged) throw new AuthorizationError('applications.pii', 'audit unavailable — refused');

    const key = labelledKeyMaterial(LEAD_PII_ENC_KEY, APPLICANT_PII_LABEL);
    const decrypt = async (v: unknown) => {
      if (typeof v !== 'string' || v.length === 0) return null;
      try {
        return await decryptPII(v, key);
      } catch {
        return null;
      }
    };
    const [email, phone] = await Promise.all([
      decrypt(row['email_enc']),
      decrypt(row['phone_enc']),
    ]);
    return { ...toAdminApplication(row), email, phone };
  },
});

export const PATCH = defineAdminRoute({
  cap: 'applications.manage',
  input: ApplicationUpdateSchema,
  handler: async ({ auth, sb, input, params, audit }) => {
    const id = requireId(params);
    const values: Record<string, unknown> = {};
    if (input.status !== undefined) values['status'] = input.status;
    if (input.internalNotes !== undefined) values['internal_notes'] = input.internalNotes;
    if (Object.keys(values).length === 0) throw new ValidationError('no updatable fields supplied');

    const { data, error } = await sb
      .from('job_applications')
      .update(values)
      .eq('tenant_id', auth.tenantId)
      .eq('id', id)
      .select(DETAIL_APPLICATION_COLUMNS)
      .maybeSingle();
    if (error) throw new Error(`update application: ${error.message}`);
    if (!data) throw new NotFoundError('application');

    audit({
      action: 'application.update',
      entityType: 'application',
      entityId: id,
      detail: { fields: Object.keys(values), status: values['status'] ?? null },
    });
    return toAdminApplication(data as unknown as Record<string, unknown>);
  },
});

export const DELETE = defineAdminRoute({
  cap: 'applications.manage',
  handler: async ({ auth, sb, params }) => {
    const id = requireId(params);
    await liveRecheck(auth);
    const row = await getRow<{ cv_path: string | null }>(
      sb,
      'job_applications',
      auth,
      id,
      'id,cv_path',
    );

    const logged = await writeAudit(sb, auth, {
      action: 'application.erase',
      entityType: 'application',
      entityId: id,
      detail: { withCv: row.cv_path !== null },
    });
    if (!logged) throw new AuthorizationError('applications.manage', 'audit unavailable — refused');

    // The object first: if it cannot be removed the row stays, so the erase can be retried
    // (a row-first erase would leave a CV no row — and no retention job — knows about).
    if (row.cv_path && !(await removeCvs(serviceClient(), [row.cv_path]))) {
      throw new Error('erase application: the CV object could not be removed');
    }
    const { error, count } = await sb
      .from('job_applications')
      .delete({ count: 'exact' })
      .eq('tenant_id', auth.tenantId)
      .eq('id', id);
    if (error) throw new Error(`erase application: ${error.message}`);
    if (!count) throw new NotFoundError('application');
    return { erased: id };
  },
});
