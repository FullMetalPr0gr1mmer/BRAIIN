import type { SupabaseClient } from '@supabase/supabase-js';
import type { ContentStatus } from '@schemas/primitives';
import type { AuthContext } from '@/lib/auth/types';
import { assertCap } from '@/lib/authz/matrix';
import { AuthorizationError } from '@/lib/authz/errors';
import { NotFoundError, OptimisticLockError, ValidationError } from './errors';

// Tenant-scoped CRUD over the RLS-bound client.
//
// Every query here repeats `.eq('tenant_id', ctx.tenantId)` even though RLS already
// enforces it. That is not redundancy for its own sake: RLS is one policy edit away
// from being wrong, and the tenant predicate is the single condition whose failure is
// silent — a broken policy leaks rows, it does not raise. Two independent statements of
// the same fact is the cheapest way to make that failure mode loud instead of quiet.
// It also puts the tenant column first in every index probe (CLAUDE.md Pillar 4).

export interface ListOptions {
  columns: string;
  orderBy?: { column: string; ascending?: boolean };
  /** Simple equality filters, e.g. `{ status: 'draft' }`. */
  filters?: Record<string, string | number | boolean | null>;
  /** Case-insensitive substring match on one column. */
  search?: { column: string; term: string } | undefined;
  limit?: number;
  offset?: number;
}

export interface ListResult<T> {
  rows: T[];
  total: number;
}

export const MAX_PAGE_SIZE = 100;

export async function listRows<T>(
  sb: SupabaseClient,
  table: string,
  ctx: AuthContext,
  opts: ListOptions,
): Promise<ListResult<T>> {
  const limit = Math.min(opts.limit ?? 50, MAX_PAGE_SIZE);
  const offset = Math.max(opts.offset ?? 0, 0);

  let q = sb
    .from(table)
    .select(opts.columns, { count: 'exact' })
    .eq('tenant_id', ctx.tenantId)
    .range(offset, offset + limit - 1);

  for (const [column, value] of Object.entries(opts.filters ?? {})) {
    q = value === null ? q.is(column, null) : q.eq(column, value);
  }
  if (opts.search && opts.search.term.length > 0) {
    // `%` and `_` are PostgREST `ilike` wildcards; escaping them keeps a user's literal
    // search text from turning into a full-table scan pattern.
    const escaped = opts.search.term.replace(/[%_\\]/g, (m) => `\\${m}`);
    q = q.ilike(opts.search.column, `%${escaped}%`);
  }
  if (opts.orderBy) {
    q = q.order(opts.orderBy.column, { ascending: opts.orderBy.ascending ?? true });
  }

  const { data, error, count } = await q;
  if (error) throw new Error(`list ${table}: ${error.message}`);
  return { rows: (data ?? []) as T[], total: count ?? 0 };
}

export async function getRow<T>(
  sb: SupabaseClient,
  table: string,
  ctx: AuthContext,
  id: string,
  columns: string,
): Promise<T> {
  const { data, error } = await sb
    .from(table)
    .select(columns)
    .eq('tenant_id', ctx.tenantId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`get ${table}: ${error.message}`);
  // "Invisible to your RLS" and "does not exist" answer identically on purpose: a
  // distinguishable 403-vs-404 turns any id-taking endpoint into an existence oracle.
  if (!data) throw new NotFoundError(table);
  return data as T;
}

export async function insertRow<T>(
  sb: SupabaseClient,
  table: string,
  ctx: AuthContext,
  values: Record<string, unknown>,
  columns: string,
): Promise<T> {
  const { data, error } = await sb
    .from(table)
    .insert({ ...values, tenant_id: ctx.tenantId })
    .select(columns)
    .single();
  if (error) throw translateWriteError(error, table);
  return data as T;
}

/**
 * Optimistic update (CLAUDE.md Pillar 4). The caller sends the `version` it read; the
 * UPDATE is guarded by it and the DB trigger does the increment.
 *
 * The pre-read exists to tell 404 and 409 apart. `UPDATE ... WHERE id AND version`
 * matching zero rows is ambiguous — gone, or moved on? — and answering 404 for a
 * conflict tells an editor their work vanished when in fact a colleague just saved.
 */
export async function updateRow<T>(
  sb: SupabaseClient,
  table: string,
  ctx: AuthContext,
  id: string,
  expectedVersion: number,
  values: Record<string, unknown>,
  columns: string,
): Promise<T> {
  const current = await getRow<{ version: number }>(sb, table, ctx, id, 'id,version');
  if (current.version !== expectedVersion) throw new OptimisticLockError(table);

  const { data, error } = await sb
    .from(table)
    .update(values)
    .eq('tenant_id', ctx.tenantId)
    .eq('id', id)
    .eq('version', expectedVersion)
    .select(columns)
    .maybeSingle();

  if (error) throw translateWriteError(error, table);
  // Lost the race between the read above and the write: someone else's UPDATE landed
  // in between and bumped the version.
  if (!data) throw new OptimisticLockError(table);
  return data as T;
}

export async function deleteRow(
  sb: SupabaseClient,
  table: string,
  ctx: AuthContext,
  id: string,
): Promise<void> {
  // Confirms existence first so a genuinely-missing row is a 404 …
  await getRow<{ id: string }>(sb, table, ctx, id, 'id');

  const { data, error } = await sb
    .from(table)
    .delete()
    .eq('tenant_id', ctx.tenantId)
    .eq('id', id)
    .select('id');
  if (error) throw translateWriteError(error, table);

  // … and a row that exists but survives DELETE is the RESTRICTIVE admin-only policy
  // filtering it out (RLS filters DELETE rows silently rather than raising). Reporting
  // 403 here rather than a cheerful 204 is what makes a drift between RLS and
  // assertCap() visible instead of looking like a successful no-op.
  if (!data || data.length === 0) {
    throw new AuthorizationError('content.archiveDelete', `RLS refused delete on '${table}'`);
  }
}

/** Postgres error codes that mean "the input was wrong", not "the server broke". */
function translateWriteError(error: { code?: string; message: string }, table: string): Error {
  switch (error.code) {
    case '23505': // unique_violation
      return new ValidationError(`duplicate value in '${table}'`, 'slug');
    case '23503': // foreign_key_violation
      return new ValidationError(`referenced row does not exist (${table})`);
    case '23514': // check_violation
      return new ValidationError(`value violates a constraint on '${table}'`);
    case '42501': // insufficient_privilege — a RESTRICTIVE policy's WITH CHECK rejected it
      return new AuthorizationError('content.archiveDelete', `RLS refused write on '${table}'`);
    default:
      return new Error(`write ${table}: ${error.message}`);
  }
}

/**
 * Lifecycle transitions carry their own capabilities, independent of the per-entity
 * write capability (CLAUDE.md §5): Content Creator authors AND publishes but may not
 * archive; Developer may do neither. Enforced here so all ten content endpoints share
 * one rule, and mirrored by the RESTRICTIVE archive policies in migrations 0001/0007.
 */
export function assertStatusTransition(ctx: AuthContext, next: ContentStatus | undefined): void {
  if (!next) return;
  if (next === 'published' || next === 'scheduled') {
    assertCap(ctx, 'content.publish');
    return;
  }
  if (next === 'archived') {
    assertCap(ctx, 'content.archiveDelete');
  }
}
