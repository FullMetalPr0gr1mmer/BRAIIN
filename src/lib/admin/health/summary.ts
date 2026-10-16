import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { can } from '@/lib/authz/matrix';
import { count, readError, record } from '../stats/read';
import {
  ERROR_WINDOW_DAYS,
  runChecklist,
  tally,
  type BackupFact,
  type CheckResult,
  type ContentHealth,
} from './checklist';
import { healthScore, scoreLabel, type HealthScore } from './score';
import {
  BUDGETED,
  HEALTH_WINDOW_DAYS,
  VITAL_NAMES,
  formatVital,
  judged,
  loadVitals,
  siteVital,
  type Rating,
  type VitalMetric,
  type VitalsReport,
} from './vitals';

// Site health, read once for a screen (Admin v2 U2): the field vitals of the last 28 days
// (rollup_daily_vitals), the checklist's counts, the errors of the last 7 days and the last
// backup export, each read only when the role holds the capability its rows need (the
// checklist's rule, README D4), all at once (at most four reads). The site health screen
// shows all of it; the dashboard's health widget (U1) shows loadHealthSummary's part.
//
// A read that fails is logged (system_logs) and its rows say "could not be read" rather than
// failing the screen: site health must still render when one source is down.

const SOURCE = 'admin:health';

export interface HealthTile {
  label: string;
  value: string;
  /** The tile's rating, when it has one (a Core Web Vital with enough visits). */
  rating?: Rating | undefined;
  /** A second line ("28 days", "Not enough visits yet"). */
  note?: string | undefined;
}

export interface HealthReport {
  vitals: VitalsReport | null;
  checks: CheckResult[];
  score: HealthScore;
  scoreLabel: string;
  tiles: HealthTile[];
  /** Errors in the last 7 days, or null when not read. */
  errors7d: number | null;
}

export interface HealthSummary {
  score: HealthScore;
  scoreLabel: string;
  tiles: HealthTile[];
  /** The first four failing rows, each with its fix link for the role (or null). */
  failing: CheckResult[];
  /** How many rows fail in all. */
  failingCount: number;
}

/**
 * Runs a read; when it fails (the loader has logged it) answers `failed` instead, so the rows
 * that need it say "could not be read" and the rest of the screen renders.
 */
async function settle<T, F>(read: () => Promise<T>, failed: F): Promise<T | F> {
  try {
    return await read();
  } catch {
    return failed;
  }
}

async function loadContentHealth(sb: SupabaseClient, auth: AuthContext): Promise<ContentHealth> {
  const { data, error } = await sb.rpc('content_health', { p_tenant: auth.tenantId });
  if (error) throw await readError(SOURCE, 'Checklist', error);
  const c = record(data);
  return {
    placeholdersLive: count(c['placeholders_live']),
    missingAlt: count(c['missing_alt']),
    consentMissing: count(c['consent_missing']),
    published: count(c['published']),
    ownDescription: count(c['own_description']),
    missingArabic: count(c['missing_arabic']),
    defaultDescriptionEn: c['default_description_en'] === true,
    defaultDescriptionAr: c['default_description_ar'] === true,
  };
}

async function loadErrorCount(sb: SupabaseClient, auth: AuthContext, now: number): Promise<number> {
  const since = new Date(now - ERROR_WINDOW_DAYS * 86_400_000).toISOString();
  const { count: n, error } = await sb
    .from('system_logs')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', auth.tenantId)
    .eq('level', 'error')
    .gte('created_at', since);
  if (error) throw await readError(SOURCE, 'Errors', error);
  return n ?? 0;
}

async function loadLastBackup(sb: SupabaseClient, auth: AuthContext): Promise<BackupFact | null> {
  const { data, error } = await sb
    .from('audit_log')
    .select('created_at,detail')
    .eq('tenant_id', auth.tenantId)
    .eq('action', 'export.backup.outcome')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw await readError(SOURCE, 'Backups', error);
  const row = Array.isArray(data) ? record(data[0]) : {};
  if (typeof row['created_at'] !== 'string') return null;
  const detail = record(row['detail']);
  return {
    at: row['created_at'],
    status: typeof detail['status'] === 'string' ? detail['status'] : 'ok',
    rows: count(detail['rows']),
  };
}

function vitalTile(report: VitalsReport | null, metric: VitalMetric): HealthTile {
  const label = VITAL_NAMES[metric];
  const row = report ? siteVital(report, metric) : null;
  const rating = judged(row);
  if (!row) return { label, value: 'No visits yet', note: `${HEALTH_WINDOW_DAYS} days` };
  return {
    label,
    value: formatVital(metric, row.p75, row.open),
    rating: rating ?? undefined,
    note: rating === null ? 'Not enough visits yet' : `${HEALTH_WINDOW_DAYS} days`,
  };
}

/** Everything the site health screen shows, read as the person (RLS decides). */
export async function loadHealthReport(
  sb: SupabaseClient,
  auth: AuthContext,
  now: number = Date.now(),
): Promise<HealthReport> {
  const may = (cap: Parameters<typeof can>[1]) => can(auth.role, cap) === 'full';
  const [vitals, content, errors7d, lastBackup] = await Promise.all([
    may('siteHealth.view') ? settle(() => loadVitals(sb, auth, HEALTH_WINDOW_DAYS), null) : null,
    settle(() => loadContentHealth(sb, auth), null),
    may('logs.view') ? settle(() => loadErrorCount(sb, auth, now), null) : null,
    // undefined: not read (no audit.view, or the read failed); null: none recorded.
    may('audit.view') ? settle(() => loadLastBackup(sb, auth), undefined) : undefined,
  ]);
  const checks = runChecklist({
    role: auth.role,
    vitals,
    content,
    errors7d,
    lastBackup,
    now,
  });
  const score = healthScore({
    vitals: BUDGETED.map((metric) => judged(vitals ? siteVital(vitals, metric) : null)),
    checks,
  });
  const { ok, judged: judgedRows } = tally(checks);
  const tiles: HealthTile[] = [
    ...BUDGETED.map((metric) => vitalTile(vitals, metric)),
    {
      label: `Errors, ${ERROR_WINDOW_DAYS} days`,
      value: errors7d === null ? 'Not checked' : errors7d.toLocaleString('en-GB'),
    },
    { label: 'Checklist', value: `${ok} / ${judgedRows}`, note: 'rows passing' },
  ];
  return { vitals, checks, score, scoreLabel: scoreLabel(score.total), tiles, errors7d };
}

/** The dashboard's part (U1's health widget): the ring, the tiles, the first failing rows. */
export async function loadHealthSummary(
  sb: SupabaseClient,
  auth: AuthContext,
  now: number = Date.now(),
): Promise<HealthSummary> {
  const report = await loadHealthReport(sb, auth, now);
  const failing = report.checks.filter((check) => check.state === 'fail');
  return {
    score: report.score,
    scoreLabel: report.scoreLabel,
    tiles: report.tiles,
    failing: failing.slice(0, 4),
    failingCount: failing.length,
  };
}
