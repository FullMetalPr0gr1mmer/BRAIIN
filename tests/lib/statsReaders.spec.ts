import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { ValidationError } from '@/lib/admin/errors';
import { loadLogs } from '@/lib/admin/health/logs';
import { loadPagePaths } from '@/lib/admin/stats/pageviews';
import { rangeOfDays } from '@/lib/admin/stats/range';
import { MAX_OFFSET, boundedOffset, readError } from '@/lib/admin/stats/read';

const { logs } = vi.hoisted(() => ({ logs: [] as unknown[] }));
vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async (entry: unknown) => {
    logs.push(entry);
    return true;
  },
}));

// The stats and health readers' bounds (Admin v2 U2 review, u2-security-1): a crafted
// `?page=` never reaches the database past pageview_paths' own bound, and a bound the
// database refuses is the request's fault: a 422, never a system_logs error row (which any
// staff member could otherwise write at will, flipping site health's errors check).

const auth = { tenantId: 't1', role: 'admin' } as AuthContext;
const range = rangeOfDays(30, Date.parse('2026-10-15T12:00:00Z'));

/** A client whose pageview_paths answers like the RPC: refuses offsets past its bound. */
function pathsClient(total: number) {
  const offsets: number[] = [];
  const sb = {
    rpc: async (_fn: string, args: { p_limit: number; p_offset: number }) => {
      offsets.push(args.p_offset);
      if (args.p_offset > MAX_OFFSET) {
        return { data: null, error: { code: '22023', message: 'a page bound is out of range' } };
      }
      const rows = Array.from(
        { length: Math.max(0, Math.min(args.p_limit, total - args.p_offset)) },
        (_, i) => ({
          path: `/p${args.p_offset + i}`,
          views: 1,
          views_en: 1,
          views_ar: 0,
          total_rows: total,
        }),
      );
      return { data: rows, error: null };
    },
  } as unknown as SupabaseClient;
  return { sb, offsets };
}

describe('the offset a page reads', () => {
  it('is clamped to the RPC bound', () => {
    expect(MAX_OFFSET).toBe(100_000);
    expect(boundedOffset(1)).toBe(0);
    expect(boundedOffset(3)).toBe(50);
    expect(boundedOffset(4001)).toBe(100_000);
    expect(boundedOffset(4002)).toBe(100_000);
    expect(boundedOffset(1e10)).toBe(100_000);
  });

  it.each([4002, 1e10])(
    'page %s: no offset past the bound is sent, nothing is logged',
    async (page) => {
      logs.length = 0;
      const { sb, offsets } = pathsClient(60);
      const result = await loadPagePaths(sb, auth, range, page);
      expect(offsets.every((o) => o <= MAX_OFFSET)).toBe(true);
      expect(result.offset).toBe(50); // the last page of 60
      expect(result.rows).toHaveLength(10);
      expect(logs).toEqual([]);
    },
  );

  it('the error log is clamped the same way', async () => {
    const ranges: number[] = [];
    // A page read past the end answers PostgREST's 416; the head count answers 0 rows.
    const from = () => {
      let ranged = false;
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order']) builder[m] = () => builder;
      builder['range'] = (start: number) => {
        ranged = true;
        ranges.push(start);
        return builder;
      };
      builder['then'] = (resolve: (v: unknown) => unknown) =>
        resolve(
          ranged
            ? { data: null, error: { code: 'PGRST103', message: 'past the end' }, count: null }
            : { data: null, error: null, count: 0 },
        );
      return builder;
    };
    const sb = { from } as unknown as SupabaseClient;
    logs.length = 0;
    const result = await loadLogs(sb, auth, { level: null, page: 1e10 });
    expect(result).toEqual({ rows: [], total: 0, offset: 0 });
    expect(ranges[0]).toBe(MAX_OFFSET);
    expect(logs).toEqual([]);
  });
});

describe('readError', () => {
  it('a bound refusal is a validation error, not logged', async () => {
    logs.length = 0;
    for (const code of ['22023', '22003']) {
      const err = await readError('admin:stats', 'Pages', { code, message: 'out of range' });
      expect(err).toBeInstanceOf(ValidationError);
    }
    expect(logs).toEqual([]);
  });

  it('anything else is logged, scrubbed', async () => {
    logs.length = 0;
    const err = await readError('admin:stats', 'Pages', { code: '42501', message: 'denied' });
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: 'error', source: 'admin:stats' });
  });
});
