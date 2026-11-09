import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { listRows } from '@/lib/admin/crud';
import type { AuthContext } from '@/lib/auth/types';

// Admin v2 Z1 baselines: a list's order is total. Rows sharing the ordered value (sections at the
// same sort order, service cases saved in one statement) came back in whatever order Postgres
// chose, so two loads of one list could differ (the visual compare caught it) and `range()` could
// page a row twice while never showing another. listRows now breaks ties on the row's id.

type Call = [string, ...unknown[]];

/** A PostgREST builder that records its calls and answers an empty page. */
function recorder() {
  const calls: Call[] = [];
  const builder: Record<string, unknown> = {};
  for (const name of ['select', 'eq', 'neq', 'is', 'ilike', 'range', 'order']) {
    builder[name] = (...args: unknown[]) => {
      calls.push([name, ...args]);
      return builder;
    };
  }
  builder['then'] = (resolve: (value: unknown) => unknown) =>
    resolve({ data: [], error: null, count: 0 });
  const sb = { from: () => builder } as unknown as SupabaseClient;
  return { sb, calls };
}

const AUTH = { tenantId: '00000000-0000-0000-0000-0000000000b1' } as AuthContext;
const orders = (calls: readonly Call[]) => calls.filter((c) => c[0] === 'order');

describe('listRows orders by the resource, then by id', () => {
  it('a sort order, ascending: then id', async () => {
    const { sb, calls } = recorder();
    await listRows(sb, 'page_sections', AUTH, {
      columns: 'id',
      orderBy: { column: 'sort_order', ascending: true },
    });
    expect(orders(calls)).toEqual([
      ['order', 'sort_order', { ascending: true }],
      ['order', 'id', { ascending: true }],
    ]);
  });

  it('newest first: then id (the cases saved in one statement)', async () => {
    const { sb, calls } = recorder();
    await listRows(sb, 'service_cases', AUTH, {
      columns: 'id',
      orderBy: { column: 'updated_at', ascending: false },
    });
    expect(orders(calls)).toEqual([
      ['order', 'updated_at', { ascending: false }],
      ['order', 'id', { ascending: true }],
    ]);
  });

  it('ordered by id already: once', async () => {
    const { sb, calls } = recorder();
    await listRows(sb, 'x', AUTH, { columns: 'id', orderBy: { column: 'id', ascending: false } });
    expect(orders(calls)).toEqual([['order', 'id', { ascending: false }]]);
  });

  it('no order asked for: none added', async () => {
    const { sb, calls } = recorder();
    await listRows(sb, 'x', AUTH, { columns: 'id' });
    expect(orders(calls)).toEqual([]);
  });
});
