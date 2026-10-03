import { ApplicationListQuerySchema } from '@schemas/application';
import { defineAdminRoute } from '@/lib/admin/route';
import { listRows } from '@/lib/admin/crud';
import { LIST_APPLICATION_COLUMNS, toAdminApplication } from '@/lib/admin/applicationFields';

// Job applications (Join) — `applications.manage`, Admin only (owner decision J6). The list
// projects no contact detail and no storage path: those leave one application at a time,
// audited, through `[id]?pii=1` and `[id]/cv`.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'applications.manage',
  input: ApplicationListQuerySchema,
  handler: async ({ auth, sb, input }) => {
    const { rows, total } = await listRows<Record<string, unknown>>(sb, 'job_applications', auth, {
      columns: LIST_APPLICATION_COLUMNS,
      orderBy: { column: 'created_at', ascending: false },
      filters: input.status ? { status: input.status } : {},
      limit: input.limit,
      offset: input.offset,
    });
    return { rows: rows.map(toAdminApplication), total, limit: input.limit, offset: input.offset };
  },
});
