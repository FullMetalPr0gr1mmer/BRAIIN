import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import {
  PROBE_COLUMNS,
  ProbeRowSchema,
  probeFacts,
  type ProbeFactsOf,
  type ProbeKind,
  type ProbeRow,
  type ProbeState,
} from '@schemas/healthProbe';
import { readError } from '../stats/read';

// Site health v2's readings, as the screens read them (Admin v2 G2): one SELECT of the
// tenant's `health_probes` rows AS THE PERSON (RLS: Admin and Developer, siteHealth.view),
// each row's facts parsed for its kind. The site health screen, its JSON twin, the dashboard
// widget (through loadHealthSummary) and the Check now route's answer share this shape.

const SOURCE = 'admin:health';

/** One probe's reading as the screens show it. */
export interface ProbeView<K extends ProbeKind = ProbeKind> {
  state: ProbeState;
  /** The parsed facts; null when there are none (never read) or they do not parse. */
  facts: ProbeFactsOf[K] | null;
  checkedAt: string | null;
  okAt: string | null;
  readOk: boolean;
  /** Failed reads in a row (six make the probe stale). */
  failures: number;
  stateSince: string;
}

/** Each probe's reading; null for a probe never checked. */
export interface ProbeReport {
  uptime: ProbeView<'uptime'> | null;
  domain: ProbeView<'domain'> | null;
  certificate: ProbeView<'certificate'> | null;
}

function viewOf<K extends ProbeKind>(kind: K, row: ProbeRow | undefined): ProbeView<K> | null {
  if (!row) return null;
  return {
    state: row.state,
    facts: probeFacts(kind, row.facts),
    checkedAt: row.checked_at,
    okAt: row.ok_at,
    readOk: row.read_ok,
    failures: row.failures,
    stateSince: row.state_since,
  };
}

/** The report from rows (as read, or as a run left them). Rows that do not parse are left out. */
export function reportOf(rows: readonly unknown[]): ProbeReport {
  const byKind = new Map<ProbeKind, ProbeRow>();
  for (const raw of rows) {
    const row = ProbeRowSchema.safeParse(raw);
    if (row.success) byKind.set(row.data.kind, row.data);
  }
  return {
    uptime: viewOf('uptime', byKind.get('uptime')),
    domain: viewOf('domain', byKind.get('domain')),
    certificate: viewOf('certificate', byKind.get('certificate')),
  };
}

/** The tenant's readings, read as the person. A failed read is logged and throws. */
export async function loadProbes(sb: SupabaseClient, auth: AuthContext): Promise<ProbeReport> {
  const { data, error } = await sb
    .from('health_probes')
    .select(PROBE_COLUMNS)
    .eq('tenant_id', auth.tenantId)
    .limit(3);
  if (error) throw await readError(SOURCE, 'Uptime and domain readings', error);
  return reportOf(Array.isArray(data) ? data : []);
}

/** The uptime figure the summary and the dashboard show. */
export interface UptimeView {
  /** `off`: not set up; `unchecked`: no reading yet; `read`: a reading (maybe stale). */
  status: 'off' | 'unchecked' | 'read';
  state: ProbeState | null;
  /** The 30-day uptime in percent, when read. */
  ratio30: number | null;
  checkedAt: string | null;
}

export function uptimeView(report: ProbeReport | null): UptimeView | null {
  if (!report) return null;
  const up = report.uptime;
  if (!up || up.state === 'off') {
    return { status: 'off', state: up?.state ?? null, ratio30: null, checkedAt: null };
  }
  const ratio30 = up.facts?.ratio30 ?? null;
  return {
    status: up.facts ? 'read' : 'unchecked',
    state: up.state,
    ratio30,
    checkedAt: up.okAt,
  };
}

/** "99.96%": two decimals, the trailing zeros kept so the figures line up. */
export function formatRatio(ratio: number): string {
  return `${(Math.floor(ratio * 100) / 100).toFixed(2)}%`;
}
