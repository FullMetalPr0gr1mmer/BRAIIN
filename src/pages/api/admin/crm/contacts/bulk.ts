import { ContactBulkSchema, type ContactBulkAction } from '@schemas/crm';
import { defineAdminRoute } from '@/lib/admin/route';
import { writeAuditMany, type AuditEntry } from '@/lib/admin/audit';
import { writeSystemLog } from '@/lib/data/systemLog';
import { contactError } from '@/lib/crm/contacts';

// One change over up to 100 contacts (Admin v2 C6): `crm.contacts`. Add or remove a tag, set
// the owner or the stage, star. No bulk delete (a person leaves by retention or an Admin's
// erasure, one at a time) and no bulk contact details.
//
// One statement, public.crm_contacts_bulk_update (0133), as the caller: RLS, the live check
// and the column grant decide which contacts change. Every contact comes back applied,
// conflict (its version moved on; the current one returned), missing (not one this caller
// can change) or skipped (ten tags already). A refused owner changes nothing at all. Then one
// audit row per changed contact and one for the batch, in ONE insert (writeAuditMany: the
// Workers Free plan's 50 subrequests); a failed insert leaves the change, answers
// `audited: false` and logs what went unrecorded, as the leads' bulk change does.

export const prerender = false;

const ACTION_FIELD: Readonly<Record<ContactBulkAction, string>> = {
  tagAdd: 'tags',
  tagRemove: 'tags',
  owner: 'owner_id',
  stage: 'stage',
  star: 'is_starred',
};

type Outcome = 'applied' | 'conflict' | 'missing' | 'skipped';
const OUTCOMES = new Set<string>(['applied', 'conflict', 'missing', 'skipped']);

interface BulkRow {
  id: string;
  version: number | null;
  outcome: Outcome;
}

/** public.crm_contacts_bulk_update's rows, checked: anything else it answered is dropped. */
function parseContactBulkRows(data: unknown): BulkRow[] {
  if (!Array.isArray(data)) return [];
  const out: BulkRow[] = [];
  for (const raw of data as Record<string, unknown>[]) {
    const id = raw['contact_id'];
    const outcome = raw['outcome'];
    if (typeof id !== 'string' || typeof outcome !== 'string' || !OUTCOMES.has(outcome)) continue;
    const version = raw['contact_version'];
    out.push({
      id,
      outcome: outcome as Outcome,
      version: typeof version === 'number' ? version : null,
    });
  }
  return out;
}

export const POST = defineAdminRoute({
  cap: 'crm.contacts',
  input: ContactBulkSchema,
  handler: async ({ auth, sb, input }) => {
    const { data, error } = await sb.rpc('crm_contacts_bulk_update', {
      p_tenant: auth.tenantId,
      p_action: input.action,
      p_value: input.value,
      p_items: input.items,
    });
    if (error) throw contactError(error, 'the change');

    const rows = parseContactBulkRows(data);
    const pick = (outcome: Outcome) => rows.filter((row) => row.outcome === outcome);
    const applied = pick('applied');
    const conflicts = pick('conflict');
    const missing = pick('missing');
    const skipped = pick('skipped');

    // Field names and ids; never a tag's words (staff type them, and they can name people).
    const entries: AuditEntry[] = applied.map((row) => ({
      action: 'crm.contact.update',
      entityType: 'contact',
      entityId: row.id,
      detail: {
        fields: [ACTION_FIELD[input.action]],
        via: 'bulk',
        action: input.action,
        ...(input.action === 'stage' ? { stage: input.value } : {}),
      },
    }));
    entries.push({
      action: 'crm.contact.bulk',
      entityType: 'contact',
      detail: {
        action: input.action,
        requested: input.items.length,
        applied: applied.length,
        conflicts: conflicts.length,
        missing: missing.length,
        skipped: skipped.length,
      },
    });
    const audited = await writeAuditMany(sb, auth, entries);
    if (!audited) {
      await writeSystemLog({
        level: 'error',
        source: 'admin:contacts-bulk',
        message: `bulk contact change applied without its audit rows (${applied.length} contacts)`,
        detail: {
          action: input.action,
          requested: input.items.length,
          applied: applied.length,
          actorId: auth.userId,
        },
      });
    }
    return {
      applied: applied.map((row) => ({ id: row.id, version: row.version })),
      conflicts: conflicts.map((row) => ({ id: row.id, version: row.version })),
      missing: missing.map((row) => row.id),
      skipped: skipped.map((row) => row.id),
      audited,
    };
  },
});
