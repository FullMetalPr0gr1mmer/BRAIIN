import { LogQuerySchema } from '@schemas/admin';
import { defineAdminRoute } from '@/lib/admin/route';
import { listRows } from '@/lib/admin/crud';

// Operational logs. `logs.view` = Admin + Developer; `logs.clear` = Admin alone.
//
// The split is the point: the role that reads logs all day is not the role that gets to
// erase them. Clearing is itself audited into `audit_log`, which has no DELETE policy
// at all — so "the logs were cleared" survives the clearing of the logs.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'logs.view',
  input: LogQuerySchema,
  handler: async ({ auth, sb, input }) => {
    const { rows, total } = await listRows<Record<string, unknown>>(sb, 'system_logs', auth, {
      columns: 'id,level,source,message,detail,created_at',
      orderBy: { column: 'created_at', ascending: false },
      filters: input.level ? { level: input.level } : {},
      limit: input.limit,
      offset: input.offset,
    });
    return { rows, total, limit: input.limit, offset: input.offset };
  },
});

export const DELETE = defineAdminRoute({
  cap: 'logs.clear',
  handler: async ({ auth, sb, audit, url }) => {
    // Bounded by default. An unqualified "delete everything" is available, but it has
    // to be asked for explicitly (`?all=1`) rather than being what happens when the
    // parameter is missing.
    const olderThanDays = Number(url.searchParams.get('olderThanDays') ?? '30');
    const all = url.searchParams.get('all') === '1';

    let query = sb.from('system_logs').delete().eq('tenant_id', auth.tenantId);
    if (!all) {
      const cutoff = new Date(
        Date.now() - Math.max(1, Math.min(365, olderThanDays)) * 86_400_000,
      ).toISOString();
      query = query.lt('created_at', cutoff);
    }

    const { data, error } = await query.select('id');
    if (error) throw new Error(`clear logs: ${error.message}`);

    audit({
      action: 'logs.clear',
      entityType: 'system_log',
      detail: { removed: data?.length ?? 0, scope: all ? 'all' : `older-than-${olderThanDays}d` },
    });
    return { removed: data?.length ?? 0 };
  },
});
