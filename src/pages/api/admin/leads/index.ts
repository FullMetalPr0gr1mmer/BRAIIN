import { LeadListQuerySchema } from '@schemas/admin';
import { defineAdminRoute } from '@/lib/admin/route';
import { listRows } from '@/lib/admin/crud';
import { SAFE_LEAD_COLUMNS, stripSensitive } from '@/lib/admin/leadFields';
import { resolveLeadInterests, withInterestLabels } from '@/lib/leads/interestLabel';

// Lead list — `leads.manage` (Admin + Developer). Content Creator and SEO hold `none`
// and are refused by assertCap before a query is built.
//
// The LIST always projects the safe columns, even for a caller who holds `leads.pii`.
// PII is fetched one lead at a time through `[id]`, which audits the view. A list that
// decrypted every row would produce one audit entry ("listed leads") covering fifty
// people's phone numbers, which is not the record PDPL Article-level accountability
// wants — and it would decrypt fifty payloads to render a table showing names.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'leads.manage',
  input: LeadListQuerySchema,
  handler: async ({ auth, sb, input }) => {
    const { rows, total } = await listRows<Record<string, unknown>>(sb, 'leads', auth, {
      columns: SAFE_LEAD_COLUMNS,
      orderBy: { column: 'created_at', ascending: false },
      filters: input.status ? { status: input.status } : {},
      search: input.q ? { column: 'name', term: input.q } : undefined,
      limit: input.limit,
      offset: input.offset,
    });

    // Readable labels for the interest slugs (old or new), resolved once per page under
    // the caller's connection — derived fields, never columns (Round 3).
    const labels = await resolveLeadInterests(sb, auth.tenantId, rows);

    return {
      rows: rows.map((row) => withInterestLabels(stripSensitive(row), labels)),
      total,
      limit: input.limit,
      offset: input.offset,
    };
  },
});
