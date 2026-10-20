import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { MAINTENANCE_DEFAULTS, readMaintenance, type MaintenanceSnapshot } from '@schemas/maintenance';
import { MAINTENANCE_KV_KEY } from '@/lib/http/maintenance';
import { __kv } from '../stubs/cloudflare-workers';

// The maintenance reconcile (Admin v2 U9b, decision D12), in the 10-minute schedule: a "Back
// on" that came is written to the row (version-checked; a race with an editor is skipped) and
// audited `maintenance.auto_disable`; the edge is healed toward OFF only, never switched on by
// a job; the buttons follow the identity while it is on; and its worst case fits the budget it
// declares (two subrequests per log line, dailyJobs.spec's method).

const state = vi.hoisted(() => ({
  logs: [] as { level: string; message: string }[],
  requests: [] as string[],
}));
vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async (entry: { level: string; message: string }) => {
    state.logs.push(entry);
    return true;
  },
}));

const { reconcileMaintenance, MAINTENANCE_RECONCILE_JOB } = await import(
  '@/lib/cron/maintenanceReconcile'
);
const { env } = await import('../stubs/cloudflare-workers');

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = Date.parse('2026-10-20T09:00:00Z');

let row: { version: number; maintenance: unknown } | null;
let updated: unknown = null;
let raced = false;
let audits: Record<string, unknown>[] = [];
let profile: Record<string, unknown> | null;

function client(): SupabaseClient {
  return {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      let patch: unknown = null;
      for (const m of ['select', 'eq']) b[m] = () => b;
      b['update'] = (p: unknown) => {
        patch = p;
        return b;
      };
      b['insert'] = async (p: Record<string, unknown>) => {
        state.requests.push(`${table}:insert`);
        audits.push(p);
        return { error: null };
      };
      b['maybeSingle'] = async () => {
        state.requests.push(`${table}:${patch ? 'update' : 'read'}`);
        if (table === 'site_profile') return { data: profile, error: null };
        if (patch) {
          if (raced) return { data: null, error: null };
          updated = (patch as { maintenance: unknown }).maintenance;
          return { data: { version: (row?.version ?? 0) + 1 }, error: null };
        }
        return { data: row, error: null };
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

const put = (value: Partial<MaintenanceSnapshot>) =>
  __kv.set(MAINTENANCE_KV_KEY, JSON.stringify({ ...MAINTENANCE_DEFAULTS, ...value }));
const edge = () => readMaintenance(__kv.get(MAINTENANCE_KV_KEY) ?? null);

beforeEach(() => {
  __kv.clear();
  state.logs = [];
  state.requests = [];
  row = null;
  updated = null;
  raced = false;
  audits = [];
  profile = { brand_name: { en: 'B', ar: 'ب' }, contact_email: 'a@example.test', whatsapp_e164: null };
});

describe('"Back on" has come', () => {
  const value = {
    ...MAINTENANCE_DEFAULTS,
    active: true,
    until: '2026-10-20',
    untilAt: '2026-10-19T21:00:00.000Z',
    changedAt: '2026-10-15T08:00:00.000Z',
  };

  it('the row says off from that instant, the edge follows, and it is audited with no actor', async () => {
    row = { version: 7, maintenance: value };
    put(value);
    const result = await reconcileMaintenance(client(), env, TENANT, NOW);
    expect(result).toEqual({ outcome: 'ended', kvSynced: true });
    expect(updated).toMatchObject({
      active: false,
      until: null,
      untilAt: null,
      changedAt: '2026-10-19T21:00:00.000Z',
    });
    expect(edge()).toMatchObject({ active: false, changedAt: '2026-10-19T21:00:00.000Z' });
    expect(audits).toEqual([
      expect.objectContaining({
        tenant_id: TENANT,
        actor_id: null,
        actor_role: null,
        action: 'maintenance.auto_disable',
        detail: { until: '2026-10-20', kvSynced: true },
      }),
    ]);
    expect(audits[0]).not.toHaveProperty('created_at');
  });

  it('an editor who saved at the same moment wins: skipped, logged, nothing else written', async () => {
    row = { version: 7, maintenance: value };
    put(value);
    raced = true;
    const result = await reconcileMaintenance(client(), env, TENANT, NOW);
    expect(result.outcome).toBe('ended-race');
    expect(audits).toEqual([]);
    expect(edge().active).toBe(true);
    expect(state.logs.map((l) => l.level)).toEqual(['warn']);
  });

  it('before the instant: the row is left alone (only the buttons follow the identity)', async () => {
    const future = { ...value, until: '2026-10-22', untilAt: '2026-10-21T21:00:00.000Z' };
    row = { version: 7, maintenance: future };
    put(future);
    expect((await reconcileMaintenance(client(), env, TENANT, NOW)).outcome).toBe('contact');
    expect(updated).toBeNull();
    expect(audits).toEqual([]);
  });
});

describe('the edge kept in step, toward OFF only', () => {
  it('the edge says on and the row says off: healed to off', async () => {
    row = { version: 3, maintenance: { ...MAINTENANCE_DEFAULTS, active: false } };
    put({ active: true });
    expect(await reconcileMaintenance(client(), env, TENANT, NOW)).toEqual({
      outcome: 'healed',
      kvSynced: true,
    });
    expect(edge().active).toBe(false);
  });

  it('the row says on and the edge does not: NEVER switched on by a job, an error logged', async () => {
    row = { version: 3, maintenance: { ...MAINTENANCE_DEFAULTS, active: true } };
    expect((await reconcileMaintenance(client(), env, TENANT, NOW)).outcome).toBe(
      'edge-off-while-on',
    );
    expect(__kv.has(MAINTENANCE_KV_KEY)).toBe(false);
    expect(state.logs.map((l) => l.level)).toEqual(['error']);
  });

  it('both off: nothing written, nothing logged', async () => {
    row = { version: 3, maintenance: { active: false, allowlist: [] } };
    expect(await reconcileMaintenance(client(), env, TENANT, NOW)).toEqual({
      outcome: 'none',
      kvSynced: null,
    });
    expect(state.logs).toEqual([]);
  });
});

describe('the buttons follow the identity while it is on', () => {
  it('a changed email reaches the edge; an unchanged one writes nothing', async () => {
    const on = { ...MAINTENANCE_DEFAULTS, active: true };
    row = { version: 3, maintenance: on };
    put({ ...on, contact: { brand: { en: 'B', ar: 'ب' }, email: 'old@example.test', whatsappE164: null } });
    expect((await reconcileMaintenance(client(), env, TENANT, NOW)).outcome).toBe('contact');
    expect(edge().contact.email).toBe('a@example.test');
    expect((await reconcileMaintenance(client(), env, TENANT, NOW)).outcome).toBe('none');
  });
});

describe('the job', () => {
  it('declares a budget its worst case (the date came) fits: 8', async () => {
    const value = {
      ...MAINTENANCE_DEFAULTS,
      active: true,
      until: '2026-10-20',
      untilAt: '2026-10-19T21:00:00.000Z',
    };
    row = { version: 7, maintenance: value };
    put(value);
    await reconcileMaintenance(client(), env, TENANT, NOW);
    // + the launch tenant's lookup (1), the edge's read (1) and write (1).
    const used = 1 + state.requests.length + 2 + 2 * state.logs.length;
    expect(used).toBeLessThanOrEqual(MAINTENANCE_RECONCILE_JOB.budget);
    expect(MAINTENANCE_RECONCILE_JOB.budget).toBe(8);
    expect(MAINTENANCE_RECONCILE_JOB.name).toBe('maintenance-reconcile');
  });
});
