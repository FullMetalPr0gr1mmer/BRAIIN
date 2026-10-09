import { LeadBulkSchema } from '@schemas/crm';
import { defineAdminRoute } from '@/lib/admin/route';
import { writeAuditMany, type AuditEntry } from '@/lib/admin/audit';
import { BULK_ACTION_FIELD, leadWriteError, parseBulkRows } from '@/lib/crm/leadWrite';

// One change over up to 100 leads (Admin v2 C3): `leads.manage`. Assign, move to a stage,
// mark or clear spam, mark read or unread, star, add or remove a tag. There is no bulk
// delete: a lead leaves through spam (its retention) or an Admin's erase, one at a time.
//
// One statement, public.leads_bulk_update (0041), as the caller: RLS, the live check and
// the column grant decide which leads change. The versioned actions change a lead only at
// the version the caller read, so every lead comes back applied, a conflict (someone else
// changed it; its current version is returned), missing (not one this caller can change)
// or skipped (left alone: ten tags already, or a race lost). A refused value (an assignee
// who does not work leads, another pipeline's stage) changes nothing at all.
//
// Then one audit row per changed lead and one for the batch, in ONE insert
// (writeAuditMany): a Worker on the Free plan has 50 subrequests per request, so neither
// the change nor its audit may cost one call per lead.

export const prerender = false;

export const POST = defineAdminRoute({
  cap: 'leads.manage',
  input: LeadBulkSchema,
  handler: async ({ auth, sb, input }) => {
    const { data, error } = await sb.rpc('leads_bulk_update', {
      p_tenant: auth.tenantId,
      p_action: input.action,
      p_value: input.value,
      p_items: input.items,
    });
    if (error) throw leadWriteError(error, 'bulk change');

    const rows = parseBulkRows(data);
    const pick = (outcome: string) => rows.filter((row) => row.outcome === outcome);
    const applied = pick('applied');
    const conflicts = pick('conflict');
    const missing = pick('missing');
    const skipped = pick('skipped');

    // Field names and ids, never a tag's words (staff type them, and they can name people).
    const field = BULK_ACTION_FIELD[input.action];
    const entries: AuditEntry[] = applied.map((row) => ({
      action: 'lead.update',
      entityType: 'lead',
      entityId: row.id,
      detail: {
        fields: [field],
        via: 'bulk',
        action: input.action,
        ...(input.action === 'stage' ? { stage: input.value } : {}),
      },
    }));
    entries.push({
      action: 'lead.bulk',
      entityType: 'lead',
      detail: {
        action: input.action,
        requested: input.items.length,
        applied: applied.length,
        conflicts: conflicts.length,
        missing: missing.length,
        skipped: skipped.length,
      },
    });
    await writeAuditMany(sb, auth, entries);

    return {
      applied: applied.map((row) => ({ id: row.id, version: row.version })),
      conflicts: conflicts.map((row) => ({ id: row.id, version: row.version })),
      missing: missing.map((row) => row.id),
      skipped: skipped.map((row) => row.id),
    };
  },
});
