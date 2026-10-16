import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { can } from '@/lib/authz/matrix';
import { addDays, type DateRange } from './range';
import { count, readError, record } from './read';

// The stats overview's lead figures (Admin v2 U2), for leads.manage holders only: how many
// leads arrived in the range and in the previous period, from public.lead_summary (0036:
// an invoker, so RLS and the live check on every lead row decide; counts only, never a
// lead). The count is `total`, every lead that arrived and is not spam, not `new` (those
// still in the first stage): a figure for a period must not shrink as the team works
// through it. A role without leads.manage gets null and nothing is read, so a Content
// Creator never learns the volume from a stats card.

export interface LeadKpis {
  /** Leads that arrived in the range (spam excluded). */
  current: number;
  /** The same for the previous period, or null when it is not compared. */
  previous: number | null;
}

/** The range's days as lead_summary's half-open timestamps: midnight UTC to midnight UTC. */
function dayWindow(from: string, to: string): { from: string; to: string } {
  return { from: `${from}T00:00:00Z`, to: `${addDays(to, 1)}T00:00:00Z` };
}

async function arrived(
  sb: SupabaseClient,
  auth: AuthContext,
  from: string,
  to: string,
): Promise<number> {
  const { data, error } = await sb.rpc('lead_summary', {
    p_tenant: auth.tenantId,
    p_filter: dayWindow(from, to),
  });
  if (error) throw await readError('admin:stats', 'Leads', error);
  return count(record(data)['total']);
}

/**
 * The range's lead count, and the previous period's when `withPrevious` (the page views'
 * rollups reach back that far, so the two changes are measured over the same days).
 */
export async function loadLeadKpis(
  sb: SupabaseClient,
  auth: AuthContext,
  range: DateRange,
  withPrevious: boolean,
): Promise<LeadKpis | null> {
  if (can(auth.role, 'leads.manage') !== 'full') return null;
  const current = await arrived(sb, auth, range.from, range.to);
  const previous = withPrevious ? await arrived(sb, auth, range.prevFrom, range.prevTo) : null;
  return { current, previous };
}

/** Inquiries per 1,000 page views, to one decimal, or null with no page views. */
export function perThousand(leads: number, views: number): number | null {
  if (!(views > 0)) return null;
  return Math.round((leads / views) * 10_000) / 10;
}
