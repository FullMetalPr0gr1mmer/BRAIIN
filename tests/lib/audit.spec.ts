import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';

// The audit chain spent twelve migrations unable to write a row: the trigger called
// pgcrypto's `hmac` unqualified, every insert raised, and writeAudit() returned `false`
// to callers that do not check it. Nothing threw, nothing logged, the CMS looked healthy
// and the compliance trail was empty. These tests pin the half that was missing —
// a failed audit write has to land somewhere a human will see.

const { logged } = vi.hoisted(() => ({ logged: [] as Record<string, unknown>[] }));

vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async (entry: Record<string, unknown>) => {
    logged.push(entry);
    return true;
  },
}));

const { writeAudit, writeAuditMany } = await import('@/lib/admin/audit');

const CTX = {
  tenantId: '00000000-0000-0000-0000-0000000000b1',
  userId: '00000000-0000-0000-0000-0000000000c1',
  role: 'admin',
} as unknown as AuthContext;

/** Minimal PostgREST-shaped stub: `.from(...).insert(...)` resolves to `{ error }`. */
function stub(
  outcome: { error: { code: string; message: string } | null } | Error,
): SupabaseClient {
  return {
    from: () => ({
      insert: async () => {
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    }),
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  logged.length = 0;
});

describe('writeAudit', () => {
  it('returns true and logs nothing on a successful write', async () => {
    const ok = await writeAudit(stub({ error: null }), CTX, { action: 'service.create' });
    expect(ok).toBe(true);
    expect(logged).toHaveLength(0);
  });

  it('reports to system_logs when the insert is REJECTED (the regression)', async () => {
    // Exactly the 0012 failure shape: the chain trigger raises, PostgREST returns an error.
    const ok = await writeAudit(
      stub({
        error: { code: '42883', message: 'function hmac(text, text, unknown) does not exist' },
      }),
      CTX,
      { action: 'service.publish', entityType: 'service', entityId: 's1' },
    );
    expect(ok).toBe(false);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.['level']).toBe('error');
    expect(logged[0]?.['source']).toBe('audit');
    expect(String(logged[0]?.['message'])).toContain('service.publish');
  });

  it('reports to system_logs when the insert THROWS', async () => {
    const ok = await writeAudit(stub(new Error('socket hang up')), CTX, {
      action: 'lead.view_pii',
    });
    expect(ok).toBe(false);
    expect(logged).toHaveLength(1);
    expect(String(logged[0]?.['message'])).toContain('lead.view_pii');
    expect((logged[0]?.['detail'] as Record<string, unknown>)['message']).toBe('socket hang up');
  });

  it('never throws — an audit failure must not roll back the operation it describes', async () => {
    await expect(writeAudit(stub(new Error('boom')), CTX, { action: 'x' })).resolves.toBe(false);
  });

  it('carries the action and entity type in detail, never the audited values', async () => {
    await writeAudit(stub({ error: { code: '42501', message: 'denied' } }), CTX, {
      action: 'lead.export',
      entityType: 'lead',
      entityId: 'l1',
      detail: { email: 'someone@example.com' }, // must NOT reach the system_logs sink
    });
    const detail = logged[0]?.['detail'] as Record<string, unknown>;
    expect(detail['action']).toBe('lead.export');
    expect(detail['entityType']).toBe('lead');
    expect(JSON.stringify(logged[0])).not.toContain('someone@example.com');
  });
});

describe('writeAuditMany (one insert for a bulk change)', () => {
  /** Records every insert call and what it was given. */
  function recording(outcome: { error: { code: string; message: string } | null } | Error) {
    const inserts: unknown[] = [];
    const sb = {
      from: (table: string) => ({
        insert: async (rows: unknown) => {
          inserts.push({ table, rows });
          if (outcome instanceof Error) throw outcome;
          return outcome;
        },
      }),
    } as unknown as SupabaseClient;
    return { sb, inserts };
  }

  it('writes every row in ONE insert, each stamped with the session', async () => {
    const { sb, inserts } = recording({ error: null });
    const ok = await writeAuditMany(sb, CTX, [
      { action: 'lead.update', entityType: 'lead', entityId: 'l1', detail: { fields: ['tags'] } },
      { action: 'lead.update', entityType: 'lead', entityId: 'l2' },
      { action: 'lead.bulk', entityType: 'lead', detail: { applied: 2 } },
    ]);
    expect(ok).toBe(true);
    expect(inserts).toHaveLength(1);
    const { table, rows } = inserts[0] as { table: string; rows: Record<string, unknown>[] };
    expect(table).toBe('audit_log');
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row['tenant_id']).toBe(CTX.tenantId);
      expect(row['actor_id']).toBe(CTX.userId);
      expect(row['actor_role']).toBe('admin');
      // The chain trigger computes these; a caller never supplies them.
      expect(row).not.toHaveProperty('hash');
      expect(row).not.toHaveProperty('prev_hash');
    }
    expect(rows.map((row) => row['entity_id'])).toEqual(['l1', 'l2', null]);
    expect(rows[1]!['detail']).toEqual({});
  });

  it('writes nothing for nothing', async () => {
    const { sb, inserts } = recording({ error: null });
    expect(await writeAuditMany(sb, CTX, [])).toBe(true);
    expect(inserts).toHaveLength(0);
  });

  it('a rejected or failed insert is false and reaches system_logs, without the values', async () => {
    const { sb } = recording({ error: { code: '42501', message: 'denied' } });
    const ok = await writeAuditMany(sb, CTX, [
      { action: 'lead.update', detail: { email: 'someone@example.com' } },
      { action: 'lead.bulk' },
    ]);
    expect(ok).toBe(false);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.['source']).toBe('audit');
    expect((logged[0]?.['detail'] as Record<string, unknown>)['actions']).toEqual([
      'lead.update',
      'lead.bulk',
    ]);
    expect(JSON.stringify(logged[0])).not.toContain('someone@example.com');
    const thrown = recording(new Error('socket hang up'));
    await expect(writeAuditMany(thrown.sb, CTX, [{ action: 'x' }])).resolves.toBe(false);
  });
});
