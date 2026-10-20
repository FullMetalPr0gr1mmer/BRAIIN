import { describe, it, expect } from 'vitest';
import {
  MAINTENANCE_DEFAULTS,
  normalizeIp,
  readMaintenance,
  type MaintenanceSnapshot,
} from '@schemas/maintenance';
import {
  effectiveState,
  getMaintenanceState,
  clientIp,
  maintenanceResponse,
  putMaintenanceState,
  readMaintenanceSnapshot,
  retryAfterSeconds,
} from '@/lib/http/maintenance';

// Maintenance mode's read path (src/lib/http/maintenance.ts, packages/schemas/maintenance.ts),
// v2 since Admin v2 U9b: one KV value carries the switch, the allowlist, the copy, the
// buttons, "Back on" and the staff bypass. Unreadable = off (fail open) with the bypass off
// (fail closed); a v1 value reads as v2 without the bypass; "Back on" ends it at its instant.

// Fake KV: only `get` is exercised by the read path.
const kv = (value: string | null) =>
  ({ SESSION: { get: async () => value } }) as unknown as Parameters<typeof getMaintenanceState>[0];

const NONCE = 'dGVzdC1ub25jZS0xMjM0';
const NOW = Date.parse('2026-10-20T09:00:00.000Z');

const on = (patch: Partial<MaintenanceSnapshot> = {}): MaintenanceSnapshot => ({
  ...MAINTENANCE_DEFAULTS,
  active: true,
  ...patch,
});

describe('getMaintenanceState: what every reader of the switch sees', () => {
  it('is inactive when the KV key is absent, or there is no binding at all', async () => {
    expect((await getMaintenanceState(kv(null), NOW)).active).toBe(false);
    expect((await getMaintenanceState({}, NOW)).active).toBe(false);
  });

  it('reads the active flag and allowlist of a v1 value, with the bypass OFF', async () => {
    const state = await getMaintenanceState(
      kv(JSON.stringify({ active: true, allowlist: ['1.2.3.4'] })),
      NOW,
    );
    expect(state.active).toBe(true);
    expect(state.allowlist).toEqual(['1.2.3.4']);
    expect(state.snapshot.staffBypass).toBe(false);
  });

  it('requires active === true exactly: no truthy coercion', async () => {
    for (const active of ['true', 1, 'yes', {}]) {
      expect((await getMaintenanceState(kv(JSON.stringify({ active })), NOW)).active).toBe(false);
    }
  });

  it('FAILS OPEN on malformed JSON (a KV blip must not 503 the whole site), bypass off', async () => {
    const state = await getMaintenanceState(kv('{{{not json'), NOW);
    expect(state.active).toBe(false);
    expect(state.snapshot.staffBypass).toBe(false);
  });

  it('FAILS OPEN when KV throws', async () => {
    const env = {
      SESSION: {
        get: async () => {
          throw new Error('kv down');
        },
      },
    } as unknown as Parameters<typeof getMaintenanceState>[0];
    expect((await getMaintenanceState(env, NOW)).active).toBe(false);
  });

  it('drops an allowlist entry that is not an address, keeps the rest', async () => {
    const state = await getMaintenanceState(
      kv(JSON.stringify({ active: true, allowlist: ['nope', '9.9.9.9', 4, '2001:DB8::1'] })),
      NOW,
    );
    expect(state.allowlist).toEqual(['9.9.9.9', '2001:db8::1']);
  });

  it('coerces a non-array allowlist to [] rather than throwing', async () => {
    const state = await getMaintenanceState(
      kv(JSON.stringify({ active: true, allowlist: 'nope' })),
      NOW,
    );
    expect(state).toMatchObject({ active: true, allowlist: [] });
  });
});

describe('the staff bypass fails closed', () => {
  it('reads on only from a v2 value that says true', () => {
    expect(readMaintenance({ v: 2, active: true, staffBypass: true }).staffBypass).toBe(true);
    expect(readMaintenance({ v: 2, active: true, staffBypass: 'true' }).staffBypass).toBe(false);
    expect(readMaintenance({ v: 2, active: true }).staffBypass).toBe(false);
    expect(readMaintenance({ active: true, staffBypass: true }).staffBypass).toBe(false);
    expect(readMaintenance('not json').staffBypass).toBe(false);
    expect(readMaintenance(null).staffBypass).toBe(false);
    expect(readMaintenance([]).staffBypass).toBe(false);
  });
});

describe('"Back on": the site comes back at the instant, with no write', () => {
  const untilAt = '2026-10-21T21:00:00.000Z';
  const value = on({ until: '2026-10-22', untilAt, changedAt: '2026-10-19T08:00:00.000Z' });

  it('is in force before the instant', () => {
    expect(effectiveState(value, Date.parse(untilAt) - 1)).toMatchObject({
      active: true,
      changedAt: '2026-10-19T08:00:00.000Z',
    });
  });

  it('is over at the instant and after, and changedAt becomes the instant (the bell)', () => {
    for (const at of [Date.parse(untilAt), Date.parse(untilAt) + 3_600_000]) {
      const state = effectiveState(value, at);
      expect(state.active).toBe(false);
      expect(state.endedByDate).toBe(true);
      expect(state.changedAt).toBe(untilAt);
    }
  });

  it('a "Back on" day without its instant is no date at all', () => {
    expect(readMaintenance({ v: 2, active: true, until: '2026-10-22' }).until).toBeNull();
    expect(readMaintenance({ v: 2, active: true, until: '2026-02-31', untilAt }).until).toBeNull();
  });
});

describe('retryAfterSeconds (decision D11)', () => {
  it('is an hour without a date', () => {
    expect(retryAfterSeconds(on(), NOW)).toBe(3600);
  });

  it('counts down to "Back on", within a minute and a day', () => {
    const at = (ms: number) =>
      on({ until: '2026-10-21', untilAt: new Date(NOW + ms).toISOString() });
    expect(retryAfterSeconds(at(5 * 3_600_000), NOW)).toBe(5 * 3600);
    expect(retryAfterSeconds(at(1_500), NOW)).toBe(60);
    expect(retryAfterSeconds(at(-60_000), NOW)).toBe(60);
    expect(retryAfterSeconds(at(9 * 86_400_000), NOW)).toBe(86_400);
    expect(retryAfterSeconds(at(90_500), NOW)).toBe(91);
  });
});

describe('normalizeIp: the same canonical form at save and at compare', () => {
  it('keeps IPv4 as written and refuses what is not one', () => {
    expect(normalizeIp('203.0.113.9')).toBe('203.0.113.9');
    expect(normalizeIp(' 203.0.113.9 ')).toBe('203.0.113.9');
    expect(normalizeIp('203.0.113.256')).toBeNull();
    expect(normalizeIp('203.0.113.09')).toBeNull();
    expect(normalizeIp('example.com')).toBeNull();
    expect(normalizeIp('')).toBeNull();
  });

  it('canonicalises IPv6 (lower case, zeros compressed)', () => {
    expect(normalizeIp('2001:DB8:0:0:0:0:0:1')).toBe('2001:db8::1');
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeIp('::ffff:203.0.113.9')).toBe('::ffff:cb00:7109');
    expect(normalizeIp('2001:db8::zz')).toBeNull();
  });
});

describe('putMaintenanceState and readMaintenanceSnapshot', () => {
  it('round-trips the whole value; false when the binding is missing or throws', async () => {
    const store = new Map<string, string>();
    const env = {
      SESSION: {
        get: async (k: string) => store.get(k) ?? null,
        put: async (k: string, v: string) => void store.set(k, v),
      },
    } as unknown as Parameters<typeof putMaintenanceState>[0];
    const value = on({
      allowlist: ['203.0.113.9'],
      staffBypass: true,
      copy: { title: { en: 'Back soon', ar: 'نعود قريبًا' }, message: null },
    });
    expect(await putMaintenanceState(env, value)).toBe(true);
    expect(await readMaintenanceSnapshot(env)).toEqual(value);
    expect(await putMaintenanceState({}, value)).toBe(false);
    const broken = {
      SESSION: {
        put: async () => {
          throw new Error('kv');
        },
      },
    } as unknown as Parameters<typeof putMaintenanceState>[0];
    expect(await putMaintenanceState(broken, value)).toBe(false);
  });

  it('reads null when there is no value, unlike the read path (which reads off)', async () => {
    expect(await readMaintenanceSnapshot(kv(null) as never)).toBeNull();
  });
});

describe('clientIp', () => {
  const req = (headers: Record<string, string>) => new Request('https://x.com/', { headers });

  it('prefers cf-connecting-ip (the only header Cloudflare sets itself)', () => {
    expect(clientIp(req({ 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': '1.1.1.1' }))).toBe(
      '9.9.9.9',
    );
  });

  it('falls back to the first x-forwarded-for entry', () => {
    expect(clientIp(req({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }))).toBe('1.1.1.1');
  });

  it('returns null when neither header is present', () => {
    expect(clientIp(req({}))).toBeNull();
  });

  it('returns null for an empty x-forwarded-for: a spoofed blank is not an allowlist match', () => {
    expect(clientIp(req({ 'x-forwarded-for': '' }))).toBeNull();
  });
});

describe('maintenanceResponse', () => {
  const res = (snapshot: MaintenanceSnapshot = on()) =>
    maintenanceResponse(NONCE, snapshot, 'en', NOW, '/_image?href=logo&w=264&h=135&f=webp');

  it('is a 503 with Retry-After', () => {
    expect(res().status).toBe(503);
    expect(res().headers.get('retry-after')).toBe('3600');
  });

  it('is never cached: the 503 must not stick in any cache', () => {
    expect(res().headers.get('cache-control')).toBe('no-store');
  });

  it('is HTML, and not noindex (a 503 already says temporary)', () => {
    expect(res().headers.get('content-type')).toContain('text/html');
    expect(res().headers.get('x-robots-tag')).toBeNull();
  });

  it('carries NO inline style attributes: the strict CSP would blank the page', async () => {
    expect(await res().text()).not.toMatch(/\sstyle=/);
  });

  it('carries its styles in a nonced <style> block matching the request nonce', async () => {
    expect(await res().text()).toContain(`<style nonce="${NONCE}">`);
  });

  it('does not break out of the nonce attribute if handed a quote', async () => {
    const html = await maintenanceResponse(
      'abc"><script>alert(1)</script>',
      on(),
      'en',
      NOW,
      null,
    ).text();
    expect(html).not.toContain('<script>');
  });
});
