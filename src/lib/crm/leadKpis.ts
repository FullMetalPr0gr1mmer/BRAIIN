// The lead KPIs (Admin v2 C4a, crm.md §9 "KPI definitions"): what POST
// /api/admin/leads/summary answers, read from public.lead_summary (0036, restated by 0063).
// Pure: the route reads the database, this shapes and compares what came back.
//
// Counts and sums only, never a lead. Two rules from the design:
//   • Conversion ("Won of all leads") is won ÷ all leads in the range, worked out here,
//     and null when there are no leads (no invented 0%).
//   • Deltas are measured against the same elapsed span one range earlier (C4b), and only
//     when a range is set: the route reads that period with a second call, and without a range
//     there is no `previous` at all.

/** The counts lead_summary answers, 0036's first. Anything else it sends is dropped. */
export const LEAD_KPI_COUNTS = [
  'total',
  'new',
  'open',
  'won',
  'lost',
  'spam',
  // (0063)
  'in_progress',
  'unread',
  'starred',
  'sla_breached',
  'web_response_n',
] as const;
export type LeadKpiCount = (typeof LEAD_KPI_COUNTS)[number];

export type LeadKpis = Record<LeadKpiCount, number> & {
  /** The won leads' value in SAR. */
  won_value: number;
  /** Hours to the first response, every source (0036); null when nothing was answered. */
  avg_first_response_hours: number | null;
  /** The same over web-form leads only (0063): the KPI card's figure. */
  web_response_hours: number | null;
  /** Won ÷ all leads in the range, 0 to 1; null when there are none. */
  conversion: number | null;
};

/** The summary for one period, with its stages' counts (stage id → non-spam leads). */
export type LeadSummary = LeadKpis & { per_stage: Record<string, number> };

/** Fewer web-form answers than this, and the response time says "Not enough data yet". */
export const MIN_RESPONSE_SAMPLE = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function count(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function hours(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** won ÷ total, or null when the period has no leads. */
export function conversionOf(won: number, total: number): number | null {
  return total > 0 ? won / total : null;
}

/** What lead_summary answered, reduced to the named figures (an unknown key never passes). */
export function readLeadKpis(raw: unknown): LeadKpis {
  const data = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = {} as Record<LeadKpiCount, number>;
  for (const key of LEAD_KPI_COUNTS) out[key] = count(data[key]);
  return {
    ...out,
    won_value: count(data['won_value']),
    avg_first_response_hours: hours(data['avg_first_response_hours']),
    web_response_hours: hours(data['web_response_hours']),
    conversion: conversionOf(out.won, out.total),
  };
}

/** The per-stage counts: stage ids only, counts only. */
export function readPerStage(raw: unknown): Record<string, number> {
  const data = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const perStage = data['per_stage'];
  const out: Record<string, number> = {};
  if (perStage && typeof perStage === 'object' && !Array.isArray(perStage)) {
    for (const [id, n] of Object.entries(perStage as Record<string, unknown>)) {
      if (UUID.test(id)) out[id] = count(n);
    }
  }
  return out;
}

const DAY_MS = 86_400_000;

/**
 * The period [from, to) is compared with: the same span moved back by its length in whole
 * days, so a range that runs from midnight to now meets the same stretch of the days before
 * it, ending at the same time of day (C4b; a whole-day range meets the days just before it).
 * The two never share a lead (lead_summary's `to` is exclusive). Null when the range is not
 * a range.
 */
export function previousPeriod(from: string, to: string): { from: string; to: string } | null {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const shift = Math.ceil((end - start) / DAY_MS) * DAY_MS;
  return { from: new Date(start - shift).toISOString(), to: new Date(end - shift).toISOString() };
}

/**
 * The change from the previous period to this one, as a fraction of the previous (0.25 is
 * up a quarter); null when there is nothing to compare with (no previous figure, or zero
 * before: any change from nothing is not a percentage).
 */
export function deltaOf(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return (current - previous) / previous;
}
