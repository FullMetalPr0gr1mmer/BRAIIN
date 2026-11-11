import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';

// The recent imports (Admin v2 C15), read as the caller: RLS shows a live crm.import holder
// the tenant's batches and nobody else anything. Counts and who imported, never a row.

export const IMPORT_BATCH_COLUMNS =
  'id,status,created_by,created_at,finished_at,expected_rows,rows_seen,created_count,' +
  'duplicate_count,repeat_count,failed_count,phone_match_count';

export interface ImportBatch {
  id: string;
  status: 'open' | 'done' | 'stopped';
  createdBy: string | null;
  createdAt: string;
  finishedAt: string | null;
  expectedRows: number;
  rows: number;
  created: number;
  duplicates: number;
  repeats: number;
  failed: number;
  phoneMatches: number;
}

const num = (v: unknown) => (typeof v === 'number' ? v : 0);

/** One batch row as the screen gets it (named fields only). */
export function toImportBatch(row: Record<string, unknown>): ImportBatch {
  const status = row['status'];
  return {
    id: String(row['id']),
    status: status === 'done' || status === 'stopped' ? status : 'open',
    createdBy: typeof row['created_by'] === 'string' ? row['created_by'] : null,
    createdAt: String(row['created_at']),
    finishedAt: typeof row['finished_at'] === 'string' ? row['finished_at'] : null,
    expectedRows: num(row['expected_rows']),
    rows: num(row['rows_seen']),
    created: num(row['created_count']),
    duplicates: num(row['duplicate_count']),
    repeats: num(row['repeat_count']),
    failed: num(row['failed_count']),
    phoneMatches: num(row['phone_match_count']),
  };
}

/** The tenant's last ten imports, newest first (ties by id). */
export async function readImportBatches(
  sb: SupabaseClient,
  auth: AuthContext,
): Promise<ImportBatch[]> {
  const { data, error } = await sb
    .from('crm_import_batches')
    .select(IMPORT_BATCH_COLUMNS)
    .eq('tenant_id', auth.tenantId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(10);
  if (error) throw new Error(`import batches: ${error.code ?? 'no code'}`);
  return ((data ?? []) as Record<string, unknown>[]).map(toImportBatch);
}

/** The counts a door answers, by name only (for the outcome audit row and the screen). */
export const IMPORT_COUNT_KEYS = [
  'rows',
  'created',
  'duplicates',
  'repeats',
  'failed',
  'phone_matches',
] as const;

export function importCounts(data: unknown): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  const answer = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  for (const key of IMPORT_COUNT_KEYS) {
    const value = answer[key];
    if (typeof value === 'number') out[key] = value;
  }
  const bases = answer['bases'];
  if (bases && typeof bases === 'object' && !Array.isArray(bases)) {
    for (const [key, value] of Object.entries(bases as Record<string, unknown>)) {
      if (/^[a-z_]{1,24}$/.test(key) && typeof value === 'number') out[`basis_${key}`] = value;
    }
  }
  return out;
}
