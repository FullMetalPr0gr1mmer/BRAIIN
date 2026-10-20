import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import { MAINTENANCE_DEFAULTS, readMaintenance } from '@schemas/maintenance';
import {
  UNTIL_PAST,
  UNTIL_TOO_FAR,
  formOf,
  planMaintenanceSave,
  storedForEditing,
} from '@/lib/admin/maintenance';
import { ValidationError } from '@/lib/admin/errors';
import { MAINTENANCE_KV_KEY } from '@/lib/http/maintenance';
import { __kv, env } from '../stubs/cloudflare-workers';

// Maintenance v2's save (Admin v2 U9b): the plan (src/lib/admin/maintenance.ts) and the route
// (src/pages/api/admin/settings/maintenance.ts). "Back on" is 00:00 that day in the studio's
// zone, tomorrow to 30 days ahead; the switch's stamp moves only when visitors would see a
// change; a value v2 never wrote that is off starts with the bypass on (D14), one that is on
// keeps the edge's reading (off); a "Back on" that came reads as off, so a save of other fields
// never turns the site back off. The route re-reads the profile first (a kill switch), writes
// the row before KV, reports a KV miss, and audits a flip or a change.

const NOW = Date.parse('2026-10-20T09:00:00Z'); // 12:00 in Riyadh, 13:00 in Dubai
const ctx = (tz = 'Asia/Riyadh') => ({ now: NOW, tz, contact: null });

describe('planMaintenanceSave: "Back on"', () => {
  it('is 00:00 that day in the studio’s zone', () => {
    expect(
      planMaintenanceSave(null, { until: '2026-10-25', version: 1 }, ctx()).next,
    ).toMatchObject({
      until: '2026-10-25',
      untilAt: '2026-10-24T21:00:00.000Z',
    });
    expect(
      planMaintenanceSave(null, { until: '2026-10-25', version: 1 }, ctx('Asia/Dubai')).next
        .untilAt,
    ).toBe('2026-10-24T20:00:00.000Z');
    expect(
      planMaintenanceSave(null, { until: '2026-10-26', version: 1 }, ctx('Europe/London')).next
        .untilAt,
    ).toBe('2026-10-26T00:00:00.000Z');
  });

  it('refuses today, a past day and more than 30 days ahead, on the field', () => {
    for (const [until, message] of [
      ['2026-10-20', UNTIL_PAST],
      ['2026-10-01', UNTIL_PAST],
      ['2026-11-20', UNTIL_TOO_FAR],
    ] as const) {
      let caught: unknown;
      try {
        planMaintenanceSave(null, { until, version: 1 }, ctx());
      } catch (err) {
        caught = err;
      }
      expect(caught, until).toBeInstanceOf(ValidationError);
      expect((caught as ValidationError).field).toBe('until');
      expect((caught as ValidationError).detail).toBe(message);
    }
    expect(() =>
      planMaintenanceSave(null, { until: '2026-11-19', version: 1 }, ctx()),
    ).not.toThrow();
  });

  it('a cleared date clears its instant', () => {
    const stored = {
      ...MAINTENANCE_DEFAULTS,
      until: '2026-10-25',
      untilAt: '2026-10-24T21:00:00.000Z',
    };
    expect(planMaintenanceSave(stored, { until: null, version: 1 }, ctx()).next).toMatchObject({
      until: null,
      untilAt: null,
    });
  });
});

describe('planMaintenanceSave: the switch and its stamp', () => {
  it('turning it on stamps now and is a flip; changing the allowlist keeps the stamp', () => {
    const on = planMaintenanceSave(
      { active: false, allowlist: [] },
      { active: true, version: 1 },
      ctx(),
    );
    expect(on.flipped).toBe(true);
    expect(on.next.changedAt).toBe(new Date(NOW).toISOString());
    const kept = planMaintenanceSave(
      {
        v: 2,
        active: true,
        allowlist: [],
        changedAt: '2026-10-09T08:00:00.000Z',
        staffBypass: true,
      },
      { allowlist: ['203.0.113.9'], version: 1 },
      ctx(),
    );
    expect(kept.flipped).toBe(false);
    expect(kept.next.changedAt).toBe('2026-10-09T08:00:00.000Z');
    expect(kept.fields).toEqual(['allowlist']);
  });

  it('a switch never recorded is not given an invented time', () => {
    const plan = planMaintenanceSave(
      { active: false, allowlist: [] },
      { active: false, version: 1 },
      ctx(),
    );
    expect(plan.next).not.toHaveProperty('changedAt');
    expect(plan.flipped).toBe(false);
  });

  it('a "Back on" that came reads as off: saving other fields never turns the site back on', () => {
    const ended = {
      v: 2,
      active: true,
      staffBypass: true,
      until: '2026-10-19',
      untilAt: '2026-10-18T21:00:00.000Z',
      changedAt: '2026-10-10T08:00:00.000Z',
    };
    expect(storedForEditing(ended, NOW)).toMatchObject({
      active: false,
      until: null,
      untilAt: null,
      changedAt: '2026-10-18T21:00:00.000Z',
    });
    const plan = planMaintenanceSave(ended, { showDate: true, version: 1 }, ctx());
    expect(plan.next.active).toBe(false);
    expect(plan.flipped).toBe(false);
    expect(formOf(ended, NOW).effective).toEqual({ active: false, endedByDate: true });
  });

  it('a value v2 never wrote: off starts with the bypass on (D14); on keeps it off (the edge’s)', () => {
    expect(storedForEditing({ active: false, allowlist: [] }, NOW).staffBypass).toBe(true);
    expect(storedForEditing({ active: true, allowlist: [] }, NOW).staffBypass).toBe(false);
    expect(storedForEditing(null, NOW).staffBypass).toBe(true);
    expect(storedForEditing({ v: 2, active: false, staffBypass: false }, NOW).staffBypass).toBe(
      false,
    );
  });

  it('takes the identity’s contact when given, else keeps the stored one', () => {
    const contact = { brand: { en: 'B', ar: 'ب' }, email: 'a@example.test', whatsappE164: null };
    expect(planMaintenanceSave(null, { version: 1 }, { ...ctx(), contact }).next.contact).toEqual(
      contact,
    );
    const stored = { ...MAINTENANCE_DEFAULTS, contact };
    expect(planMaintenanceSave(stored, { version: 1 }, ctx()).next.contact).toEqual(contact);
  });
});

// ── The route ──────────────────────────────────────────────────────────────────────────

const state = vi.hoisted(() => ({
  rechecks: 0,
  recheckFails: false,
  order: [] as string[],
  audits: [] as { action: string; detail?: Record<string, unknown> }[],
}));

vi.mock('@/lib/admin/liveRecheck', () => ({
  liveRecheck: async () => {
    state.rechecks += 1;
    const { AuthorizationError } = await import('@/lib/authz/errors');
    if (state.recheckFails) throw new AuthorizationError('live-recheck', 'account disabled');
  },
}));
vi.mock('@/lib/admin/audit', () => ({
  writeAudit: async (
    _sb: unknown,
    _auth: unknown,
    entry: { action: string; detail?: Record<string, unknown> },
  ) => {
    state.audits.push(entry);
    return true;
  },
}));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AUTH = {
  userId: '11111111-1111-4111-8111-111111111111',
  tenantId: TENANT,
  role: 'developer' as const,
  isActive: true,
  email: 'd@example.test',
};

let stored: { version: number; maintenance: unknown } | null;
let written: unknown = null;

function client() {
  return {
    rpc: async () => ({ data: false, error: null }),
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      let patch: unknown = null;
      for (const m of ['select', 'eq']) b[m] = () => b;
      b['update'] = (p: unknown) => {
        patch = p;
        return b;
      };
      b['insert'] = (p: unknown) => {
        patch = p;
        return b;
      };
      b['maybeSingle'] = async () => {
        if (table === 'site_profile') {
          return {
            data: {
              brand_name: { en: 'Braiin', ar: 'بريّن' },
              contact_email: 'hello@example.test',
              whatsapp_e164: null,
            },
            error: null,
          };
        }
        if (table === 'site_settings' && patch !== null) {
          state.order.push('row');
          written = (patch as { maintenance: unknown }).maintenance;
          return { data: { version: (stored?.version ?? 0) + 1 }, error: null };
        }
        if (table === 'site_settings') {
          return { data: stored, error: null };
        }
        return { data: null, error: null };
      };
      b['single'] = async () => {
        state.order.push('row');
        written = (patch as { maintenance: unknown }).maintenance;
        return { data: { version: 1 }, error: null };
      };
      return b;
    },
  };
}

async function patch(body: Record<string, unknown>) {
  const { PATCH } = (await import('@/pages/api/admin/settings/maintenance')) as { PATCH: APIRoute };
  const request = new Request('https://admin.example.test/api/admin/settings/maintenance', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.7' },
    body: JSON.stringify(body),
  });
  return (await PATCH({
    locals: { session: AUTH, supabase: client(), cspNonce: 'n' },
    request,
    url: new URL(request.url),
    params: {},
  } as unknown as Parameters<APIRoute>[0])) as Response;
}

const realPut = env.SESSION.put;
beforeEach(() => {
  __kv.clear();
  state.rechecks = 0;
  state.recheckFails = false;
  state.order = [];
  state.audits = [];
  stored = { version: 4, maintenance: { active: false, allowlist: [] } };
  written = null;
  env.SESSION.put = async (key: string, value: string) => {
    state.order.push('kv');
    await realPut(key, value);
  };
});

describe('PATCH /api/admin/settings/maintenance', () => {
  it('re-reads the profile, writes the row, THEN the edge, and audits the flip', async () => {
    const res = await patch({ active: true, staffBypass: true, version: 4 });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(state.rechecks).toBe(1);
    expect(state.order).toEqual(['row', 'kv']);
    const edge = readMaintenance(__kv.get(MAINTENANCE_KV_KEY) ?? null);
    expect(edge).toMatchObject({ active: true, staffBypass: true });
    expect(edge.contact).toEqual({
      brand: { en: 'Braiin', ar: 'بريّن' },
      email: 'hello@example.test',
      whatsappE164: null,
    });
    expect(written).toEqual(JSON.parse(__kv.get(MAINTENANCE_KV_KEY)!));
    expect(state.audits.map((a) => a.action)).toEqual(['maintenance.enable']);
    expect(state.audits[0]!.detail).toMatchObject({
      kvSynced: true,
      ip: '198.51.100.7',
      staffBypass: true,
      allowlistSize: 0,
    });
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({ kvSynced: true, version: 5, effective: { active: true } });
  });

  it('a change that is not a flip audits maintenance.update with the field names only', async () => {
    stored = { version: 4, maintenance: { v: 2, active: false, allowlist: [], staffBypass: true } };
    await patch({ title: { en: 'Back soon', ar: 'نعود قريبًا' }, version: 4 });
    expect(state.audits.map((a) => a.action)).toEqual(['maintenance.update']);
    expect(state.audits[0]!.detail?.['fields']).toEqual(['title']);
    expect(JSON.stringify(state.audits[0]!.detail)).not.toContain('Back soon');
  });

  it('turning it off audits maintenance.disable', async () => {
    stored = { version: 4, maintenance: { v: 2, active: true, allowlist: [], staffBypass: true } };
    await patch({ active: false, version: 4 });
    expect(state.audits.map((a) => a.action)).toEqual(['maintenance.disable']);
  });

  it('reports a KV miss as kvSynced: false, never as success', async () => {
    env.SESSION.put = async () => {
      throw new Error('kv down');
    };
    const res = await patch({ active: true, version: 4 });
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data['kvSynced']).toBe(false);
    expect(state.audits[0]!.detail?.['kvSynced']).toBe(false);
  });

  it('a stale version is a 409, nothing written', async () => {
    const res = await patch({ active: true, version: 3 });
    expect(res.status).toBe(409);
    expect(state.order).toEqual([]);
  });

  it('a "Back on" that is not tomorrow to 30 days ahead is a 422 on until', async () => {
    const res = await patch({ until: '2000-01-01', version: 4 });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain('until');
    expect(state.order).toEqual([]);
  });

  it('a profile that no longer stands (the live recheck) is a 403, nothing written', async () => {
    state.recheckFails = true;
    const res = await patch({ active: true, version: 4 });
    expect(res.status).toBe(403);
    expect(state.order).toEqual([]);
  });
});
