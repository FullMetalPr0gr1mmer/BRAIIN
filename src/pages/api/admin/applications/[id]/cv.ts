import { z } from 'zod';
import { CV_KINDS } from '@schemas/application';
import { defineAdminRoute } from '@/lib/admin/route';
import { NotFoundError } from '@/lib/admin/errors';
import { AuthorizationError } from '@/lib/authz/errors';
import { getRow } from '@/lib/admin/crud';
import { writeAudit } from '@/lib/admin/audit';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { claimPrivilegedOp } from '@/lib/admin/rateLimit';
import { serviceClient } from '@/lib/supabase/server';
import { downloadCv } from '@/lib/applications/storage';

// GET /api/admin/applications/[id]/cv — the one way a CV leaves the private bucket.
//
//   applications.pii (Admin only) → live recheck → a privileged-op limit (a reviewer reads
//   many CVs; a scraper reads more) → the row through RLS, so the path comes from the
//   tenant's own record and never from the request → an audit row written BEFORE the file,
//   refused if it cannot be → the file, as an attachment.
//
// Served so a browser never renders it: `attachment`, `nosniff`, `no-store`, and a CSP
// `sandbox` (kept by applySecurityHeaders) for the case where someone opens the URL in a
// tab anyway. The CV has not been virus-scanned (EXC-008) — the panel says so.

export const prerender = false;

const CV_LIMITS = { perUser: 60, perTenant: 120, windowMinutes: 60 };

export const GET = defineAdminRoute({
  cap: 'applications.pii',
  handler: async ({ auth, sb, params }) => {
    const id = params['id'];
    if (!id || !z.string().uuid().safeParse(id).success) throw new NotFoundError('application');

    await liveRecheck(auth);
    await claimPrivilegedOp(auth, 'application-cv', CV_LIMITS);

    const row = await getRow<{ cv_path: string | null; cv_content_type: string | null }>(
      sb,
      'job_applications',
      auth,
      id,
      'id,cv_path,cv_content_type',
    );
    if (!row.cv_path || !row.cv_content_type) throw new NotFoundError('cv');

    const logged = await writeAudit(sb, auth, {
      action: 'application.cv_download',
      entityType: 'application',
      entityId: id,
    });
    if (!logged) throw new AuthorizationError('applications.pii', 'audit unavailable — refused');

    const file = await downloadCv(serviceClient(), row.cv_path);
    if (!file) throw new Error('cv download: object unavailable');

    const ext = row.cv_content_type === CV_KINDS.docx.contentType ? 'docx' : 'pdf';
    return new Response(file, {
      status: 200,
      headers: {
        'content-type': row.cv_content_type,
        'content-disposition': `attachment; filename="cv-${id.slice(0, 8)}.${ext}"`,
        'content-length': String(file.size),
        'cache-control': 'private, no-store, max-age=0, must-revalidate',
        'x-content-type-options': 'nosniff',
        'content-security-policy': 'sandbox',
      },
    });
  },
});
