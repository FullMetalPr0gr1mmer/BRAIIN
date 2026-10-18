import type { SupabaseClient } from '@supabase/supabase-js';
import { ValidationError } from '@/lib/admin/errors';
import { resolveLeadInterests, withInterestLabels } from '@/lib/leads/interestLabel';
import { LEAD_CARD_FIELDS, LEAD_LIST_FIELDS, pick } from './leadQuery';
import { previousPeriod, readLeadKpis, readPerStage, type LeadKpis } from './leadKpis';

// The lead readers as the Worker calls them (Admin v2 C4b): POST /api/admin/leads/query,
// /board and /summary, and the leads pages' server render (src/lib/crm/leadPage.ts), so a
// page's first view and its island's later reads answer the same shape. Each runs as the
// caller (the RPCs are SECURITY INVOKER: RLS, the live check and the column grants decide)
// for the caller's tenant, and cuts what came back to the safe fields again
// (LEAD_LIST_FIELDS, LEAD_CARD_FIELDS); never a tag, a score reason, an index or a
// ciphertext. A filter the database refuses (22023) is a 422.

export type LeadRow = Record<(typeof LEAD_LIST_FIELDS)[number], unknown> & {
  service_label?: { en: string; ar: string };
  discipline_label?: { en: string; ar: string };
};
export type LeadCard = Record<(typeof LEAD_CARD_FIELDS)[number], unknown> & {
  service_label?: { en: string; ar: string };
  discipline_label?: { en: string; ar: string };
};

export interface LeadPage {
  rows: LeadRow[];
  total: number;
}

export interface BoardColumn {
  stage_id: unknown;
  total: number;
  value_sum: number;
  leads: LeadCard[];
}

/** The summary for a range, and the same elapsed span before it when the range is whole. */
export type LeadSummaryAnswer = LeadKpis & {
  per_stage: Record<string, number>;
  previous: LeadKpis | null;
};

/** One page of public.leads_list for an RPC filter (snake_case keys). */
export async function readLeadList(
  sb: SupabaseClient,
  tenantId: string,
  filter: Record<string, unknown>,
): Promise<LeadPage> {
  const { data, error } = await sb.rpc('leads_list', { p_tenant: tenantId, p_filter: filter });
  if (error) {
    if (error.code === '22023') throw new ValidationError('lead filter refused');
    throw new Error(`leads_list: ${error.message}`);
  }
  const page = (data ?? {}) as { total?: unknown; rows?: unknown };
  const total = Number(page.total ?? 0);
  const found = Array.isArray(page.rows) ? (page.rows as Record<string, unknown>[]) : [];
  const rows = found.map((row) => pick(row, LEAD_LIST_FIELDS));
  const labels = await resolveLeadInterests(sb, tenantId, rows);
  return { rows: rows.map((row) => withInterestLabels(row, labels)), total };
}

/** public.leads_board for an RPC filter: every stage, its count, its value sum, its cards. */
export async function readLeadBoard(
  sb: SupabaseClient,
  tenantId: string,
  filter: Record<string, unknown>,
): Promise<BoardColumn[]> {
  const { data, error } = await sb.rpc('leads_board', { p_tenant: tenantId, p_filter: filter });
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
      value_sum: Number(column['value_sum'] ?? 0),
      leads: cards.map((card) => pick(card, LEAD_CARD_FIELDS)),
    };
  });
  // Labels for every card on the board at once: two queries, not two per card.
  const labels = await resolveLeadInterests(
    sb,
    tenantId,
    columns.flatMap((column) => column.leads),
  );
  return columns.map((column) => ({
    ...column,
    leads: column.leads.map((card) => withInterestLabels(card, labels)),
  }));
}

async function summaryOf(
  sb: SupabaseClient,
  tenantId: string,
  filter: Record<string, unknown>,
): Promise<unknown> {
  const { data, error } = await sb.rpc('lead_summary', { p_tenant: tenantId, p_filter: filter });
  if (error) {
    if (error.code === '22023') throw new ValidationError('summary filter refused');
    throw new Error(`lead_summary: ${error.message}`);
  }
  return data;
}

/**
 * public.lead_summary for a range (`from` and `to`, both or neither): one read, and with a
 * whole range a second over the same elapsed span before it, for the deltas.
 */
export async function readLeadSummary(
  sb: SupabaseClient,
  tenantId: string,
  range: { from?: string | undefined; to?: string | undefined },
): Promise<LeadSummaryAnswer> {
  const filter: Record<string, unknown> = {};
  if (range.from) filter['from'] = range.from;
  if (range.to) filter['to'] = range.to;
  const before = range.from && range.to ? previousPeriod(range.from, range.to) : null;
  const [current, earlier] = await Promise.all([
    summaryOf(sb, tenantId, filter),
    before ? summaryOf(sb, tenantId, before) : Promise.resolve(null),
  ]);
  const previous: LeadKpis | null = before ? readLeadKpis(earlier) : null;
  return { ...readLeadKpis(current), per_stage: readPerStage(current), previous };
}
