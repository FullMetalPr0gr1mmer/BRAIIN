import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { PAGE_SIZE, offsetOf, pageInfo } from '../pager';
import { readFailed } from '../stats/read';

// The Errors tab of site health (Admin v2 U2; it replaces /admin/logs, now a redirect): one
// page of system_logs, newest first, optionally one level. logs.view (Admin, Developer), as
// the table's RLS (system_logs_read). The rows are what the writers logged: every writer
// scrubs personal data before it writes (src/lib/data/systemLog.ts and its callers), and the
// page prints them as text, never markup.

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LOG_LEVEL_LABEL: Readonly<Record<LogLevel, string>> = {
  error: 'Error',
  warn: 'Warning',
  info: 'Info',
  debug: 'Debug',
};

export interface LogRow {
  id: number;
  level: LogLevel;
  source: string | null;
  message: string;
  /** The detail as indented JSON text, or null when it is empty. */
  detail: string | null;
  created_at: string;
}

export interface LogPage {
  rows: LogRow[];
  total: number;
  /** The offset read: the URL's page, clamped to the last page there is. */
  offset: number;
}

/** A level from a query parameter, or null for every level. */
export function levelParam(value: string | null | undefined): LogLevel | null {
  return (LOG_LEVELS as readonly string[]).includes(value ?? '') ? (value as LogLevel) : null;
}

function detailText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && Object.keys(value as object).length === 0) return null;
  return JSON.stringify(value, null, 2);
}

/** PostgREST's answer to a range that starts past the last row (HTTP 416). */
const PAST_THE_END = 'PGRST103';

async function pageAt(
  sb: SupabaseClient,
  auth: AuthContext,
  level: LogLevel | null,
  offset: number,
): Promise<{ rows: LogRow[]; total: number | null }> {
  let query = sb
    .from('system_logs')
    .select('id,level,source,message,detail,created_at', { count: 'exact' })
    .eq('tenant_id', auth.tenantId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);
  if (level) query = query.eq('level', level);
  const { data, error, count } = await query;
  if (error?.code === PAST_THE_END) return { rows: [], total: null };
  if (error) throw await readFailed('admin:health', 'Errors', error.message);
  const rows = (Array.isArray(data) ? data : []) as Record<string, unknown>[];
  return {
    rows: rows.map((row) => ({
      id: Number(row['id']),
      level: levelParam(String(row['level'])) ?? 'info',
      source: typeof row['source'] === 'string' ? row['source'] : null,
      message: String(row['message'] ?? ''),
      detail: detailText(row['detail']),
      created_at: String(row['created_at'] ?? ''),
    })),
    total: count ?? 0,
  };
}

async function countAll(
  sb: SupabaseClient,
  auth: AuthContext,
  level: LogLevel | null,
): Promise<number> {
  let query = sb
    .from('system_logs')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', auth.tenantId);
  if (level) query = query.eq('level', level);
  const { count, error } = await query;
  if (error) throw await readFailed('admin:health', 'Errors', error.message);
  return count ?? 0;
}

/** One page of the log (`page` is 1-based); a page past the end reads the last page. */
export async function loadLogs(
  sb: SupabaseClient,
  auth: AuthContext,
  { level, page }: { level: LogLevel | null; page: number },
): Promise<LogPage> {
  const offset = offsetOf(page);
  const first = await pageAt(sb, auth, level, offset);
  if (first.rows.length > 0 || offset === 0) {
    return { rows: first.rows, total: first.total ?? first.rows.length, offset };
  }
  const total = first.total ?? (await countAll(sb, auth, level));
  if (total === 0) return { rows: [], total: 0, offset: 0 };
  const last = pageInfo(total, offset).offset;
  const read = await pageAt(sb, auth, level, last);
  return { rows: read.rows, total: read.total ?? total, offset: last };
}
