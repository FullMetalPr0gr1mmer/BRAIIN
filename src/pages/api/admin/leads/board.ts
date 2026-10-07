import { LEAD_PII_ENC_KEY } from 'astro:env/server';
import { LeadBoardQuerySchema } from '@schemas/crm';
import { defineAdminRoute } from '@/lib/admin/route';
import { ValidationError } from '@/lib/admin/errors';
import { LEAD_CARD_FIELDS, pick, tenantCountry, toRpcFilter } from '@/lib/crm/leadQuery';
import { resolveLeadInterests, withInterestLabels } from '@/lib/leads/interestLabel';

// The pipeline board (Admin v2 C2a): every stage of the caller's tenant with its count and
// newest cards, spam excluded. `leads.manage`; runs as the caller (public.leads_board), for
// the caller's tenant.

export const prerender = false;

export const POST = defineAdminRoute({
  cap: 'leads.manage',
  input: LeadBoardQuerySchema,
  handler: async ({ auth, sb, input }) => {
    const filter = await toRpcFilter(
      LEAD_PII_ENC_KEY,
      auth.tenantId,
      input,
      tenantCountry(sb, auth.tenantId),
    );
    const { data, error } = await sb.rpc('leads_board', {
      p_tenant: auth.tenantId,
      p_filter: filter,
    });
    if (error) {
      if (error.code === '22023') throw new ValidationError('board filter refused');
      throw new Error(`leads_board: ${error.message}`);
    }
    const columns = ((data ?? []) as Record<string, unknown>[]).map((column) => {
      const cards = Array.isArray(column['leads'])
        ? (column['leads'] as Record<string, unknown>[])
        : [];
      return {
        stage_id: column['stage_id'] ?? null,
        total: Number(column['total'] ?? 0),
        leads: cards.map((card) => pick(card, LEAD_CARD_FIELDS)),
      };
    });
    // Labels for every card on the board at once: two queries, not two per card.
    const labels = await resolveLeadInterests(
      sb,
      auth.tenantId,
      columns.flatMap((column) => column.leads),
    );
    return {
      columns: columns.map((column) => ({
        ...column,
        leads: column.leads.map((card) => withInterestLabels(card, labels)),
      })),
    };
  },
});
