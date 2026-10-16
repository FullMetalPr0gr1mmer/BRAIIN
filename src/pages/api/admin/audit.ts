import { ActivityQuerySchema } from '@schemas/audit';
import { defineAdminRoute } from '@/lib/admin/route';
import { loadActivity } from '@/lib/admin/activity';
import { KIND_BADGE, sentence } from '@/lib/admin/auditLabels';
import { PAGE_SIZE } from '@/lib/admin/pager';

// The activity log as JSON: the twin of /admin/audit (Admin v2 U13), `audit.view` (Admin +
// Developer), the same filters (packages/schemas/audit.ts) and the same reads
// (src/lib/admin/activity.ts): a page of 25 entries, newest first, each in plain words with
// the person's name, and the chain check over the newest entries, unfiltered.
//
// Read-only by construction: the table has no UPDATE or DELETE policy and no API role holds
// either privilege (0002, 0050), so there is no write method to mirror. Field names only,
// never `detail`'s values; no hashes.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'audit.view',
  input: ActivityQuerySchema,
  handler: async ({ auth, sb, input }) => {
    const result = await loadActivity(sb, auth, input);
    return {
      rows: result.entries.map((entry) => ({
        id: entry.id,
        at: entry.at,
        who: entry.who,
        kind: entry.description.kind,
        kindLabel: KIND_BADGE[entry.description.kind].label,
        what: sentence(entry.description, entry.title),
        verb: entry.description.verb,
        noun: entry.description.noun,
        title: entry.title,
        fields: entry.description.fields,
        itemType: entry.itemType,
        itemId: entry.itemId,
      })),
      total: result.total,
      page: result.page,
      limit: PAGE_SIZE,
      chain: result.chain,
    };
  },
});
