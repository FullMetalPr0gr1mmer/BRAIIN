import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuthContext } from '@/lib/auth/types';

// The privileged-op ledger (export-backup, export-csv, the admin CV download): one claim
// per operation, written BEFORE the window is counted so parallel requests cannot all pass
// a count none of them has joined; a refused claim removes its own row; any ledger failure
// refuses the operation (fails closed).

interface Ledger {
  rows: { id: number; actor: string; tenant: string; op: string }[];
  insertFails: boolean;
  countFails: boolean;
  calls: string[];
}
const ledger: Ledger = { rows: [], insertFails: false, countFails: false, calls: [] };
let nextId = 1;

vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({
    from: () => {
      const filters: Record<string, unknown> = {};
      let mode: 'count' | 'delete' = 'count';
      const b: Record<string, unknown> = {};
      b['insert'] = (row: { tenant_id: string; actor_id: string; op: string }) => {
        ledger.calls.push('insert');
        const sel = {
          select: () => ({
            single: async () => {
              if (ledger.insertFails) return { data: null, error: { message: 'down' } };
              const id = nextId++;
              ledger.rows.push({ id, actor: row.actor_id, tenant: row.tenant_id, op: row.op });
              return { data: { id }, error: null };
            },
          }),
        };
        return sel;
      };
      b['select'] = () => b;
      b['gte'] = () => b;
      b['delete'] = () => {
        mode = 'delete';
        return b;
      };
      b['eq'] = (col: string, v: unknown) => {
        filters[col] = v;
        if (mode === 'delete' && col === 'id') {
          ledger.calls.push('delete');
          ledger.rows = ledger.rows.filter((r) => r.id !== v);
          return Promise.resolve({ error: null });
        }
        return b;
      };
      b['then'] = (ok: (v: unknown) => unknown) => {
        ledger.calls.push('count');
        if (ledger.countFails) return Promise.resolve(ok({ count: null, error: { message: 'x' } }));
        const count = ledger.rows.filter(
          (r) =>
            r.tenant === filters['tenant_id'] &&
            r.op === filters['op'] &&
            (filters['actor_id'] === undefined || r.actor === filters['actor_id']),
        ).length;
        return Promise.resolve(ok({ count, error: null }));
      };
      return b;
    },
  }),
}));

const { claimPrivilegedOp } = await import('@/lib/admin/rateLimit');
const { RateLimitError } = await import('@/lib/admin/errors');

const auth = (userId: string, tenantId = 'T'): AuthContext =>
  ({ userId, tenantId, role: 'admin', email: 'a@x', isActive: true }) as AuthContext;
const LIMITS = { perUser: 2, perTenant: 3, windowMinutes: 60 };

beforeEach(() => {
  ledger.rows = [];
  ledger.insertFails = false;
  ledger.countFails = false;
  ledger.calls = [];
});

describe('claimPrivilegedOp', () => {
  it('records the claim FIRST, then counts the window including it', async () => {
    await claimPrivilegedOp(auth('u1'), 'export-csv', LIMITS);
    expect(ledger.calls).toEqual(['insert', 'count', 'count']);
    expect(ledger.rows).toHaveLength(1);
  });

  it('allows up to the per-user limit, refuses the next — and removes the refused row', async () => {
    await claimPrivilegedOp(auth('u1'), 'export-csv', LIMITS);
    await claimPrivilegedOp(auth('u1'), 'export-csv', LIMITS);
    await expect(claimPrivilegedOp(auth('u1'), 'export-csv', LIMITS)).rejects.toThrow(
      RateLimitError,
    );
    // Retrying while over the limit does not keep the window full.
    expect(ledger.rows).toHaveLength(2);
    expect(ledger.calls.at(-1)).toBe('delete');
  });

  it('the tenant ceiling catches several accounts each under their own limit', async () => {
    await claimPrivilegedOp(auth('u1'), 'export-csv', LIMITS);
    await claimPrivilegedOp(auth('u2'), 'export-csv', LIMITS);
    await claimPrivilegedOp(auth('u3'), 'export-csv', LIMITS);
    await expect(claimPrivilegedOp(auth('u4'), 'export-csv', LIMITS)).rejects.toThrow(
      /export-csv:tenant/,
    );
  });

  it('parallel claims cannot all pass: at most the limit go through', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => claimPrivilegedOp(auth('u1'), 'application-cv', LIMITS)),
    );
    const passed = results.filter((r) => r.status === 'fulfilled').length;
    expect(passed).toBeLessThanOrEqual(LIMITS.perUser);
  });

  it('fails CLOSED when the claim cannot be written — and counts nothing', async () => {
    ledger.insertFails = true;
    await expect(claimPrivilegedOp(auth('u1'), 'export-backup', LIMITS)).rejects.toThrow(
      /export-backup:unavailable/,
    );
    expect(ledger.calls).toEqual(['insert']);
  });

  it('fails CLOSED when the window cannot be read, and removes its claim', async () => {
    ledger.countFails = true;
    await expect(claimPrivilegedOp(auth('u1'), 'export-backup', LIMITS)).rejects.toThrow(
      /unavailable/,
    );
    expect(ledger.rows).toHaveLength(0);
  });

  it('operations are counted separately', async () => {
    await claimPrivilegedOp(auth('u1'), 'export-csv', LIMITS);
    await claimPrivilegedOp(auth('u1'), 'export-csv', LIMITS);
    await expect(claimPrivilegedOp(auth('u1'), 'application-cv', LIMITS)).resolves.toBeUndefined();
  });
});
