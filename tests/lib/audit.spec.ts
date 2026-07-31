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

const { writeAudit } = await import('@/lib/admin/audit');

const CTX = {
  tenantId: '00000000-0000-0000-0000-0000000000b1',
  userId: '00000000-0000-0000-0000-0000000000c1',
  role: 'admin',
} as unknown as AuthContext;

/** Minimal PostgREST-shaped stub: `.from(...).insert(...)` resolves to `{ error }`. */
function stub(outcome: { error: { code: string; message: string } | null } | Error): SupabaseClient {
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
      stub({ error: { code: '42883', message: 'function hmac(text, text, unknown) does not exist' } }),
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
    const ok = await writeAudit(stub(new Error('socket hang up')), CTX, { action: 'lead.view_pii' });
    expect(ok).toBe(false);
    expect(logged).toHaveLength(1);
    expect(String(logged[0]?.['message'])).toContain('lead.view_pii');
    expect((logged[0]?.['detail'] as Record<string, unknown>)['message']).toBe('socket hang up');
  });

  it('never throws — an audit failure must not roll back the operation it describes', async () => {
    await expect(
      writeAudit(stub(new Error('boom')), CTX, { action: 'x' }),
    ).resolves.toBe(false);
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
