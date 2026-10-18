import { describe, expect, it, vi } from 'vitest';
import { uptimeProvider, UptimeProviderError } from '@/lib/health/uptime';
import {
  MONITOR_IDS,
  readingOf,
  requestBody,
  riyadhDay,
  stripRanges,
  uptimeRobot,
} from '@/lib/health/uptime/uptimeRobot';

// The UptimeRobot adapter (Admin v2 G2, decision D1; the legacy v2 getMonitors API, verified
// 2026-10-18): the request it sends (one POST, the read-only key in the body, 90 Riyadh-day
// ranges), and what it makes of the answer, pinned on fixtures shaped like the documented
// response: all up, one down, seems down, paused, an API failure, a malformed body, no ssl,
// more than five monitors, and a monitor on another host.

const SITE = 'https://braiin-station.example.workers.dev';
// 15 Oct 2026, 12:00 UTC: 15:00 in Riyadh.
const NOW = new Date('2026-10-15T12:00:00Z');
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

const ranges = (value: string) => Array.from({ length: 90 }, () => value).join('-');

function monitor(over: Record<string, unknown> = {}) {
  return {
    id: 777001,
    friendly_name: 'Home',
    url: `${SITE}/`,
    type: 1,
    interval: 300,
    status: 2,
    custom_uptime_ratio: '99.980-99.910',
    custom_uptime_ranges: ranges('100.000'),
    logs: [],
    response_times: [
      { datetime: sec('2026-10-15T11:00:00Z'), value: 210 },
      { datetime: sec('2026-10-15T10:00:00Z'), value: 190 },
    ],
    ssl: { brand: "Let's Encrypt", product: 'R11', expires: sec('2026-12-14T00:00:00Z') },
    ...over,
  };
}
const answer = (...monitors: unknown[]) => ({
  stat: 'ok',
  pagination: { offset: 0, limit: 5, total: monitors.length },
  monitors,
});

describe('the request', () => {
  it('is one form body with the key and the documented parameters, no key in the URL', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(answer(monitor())), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = uptimeRobot({
      key: 'ro-key-abc',
      ids: '777001-777002',
      siteUrl: SITE,
      outbound: { fetchImpl },
    });
    await provider.read(NOW);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.uptimerobot.com/v2/getMonitors');
    expect(calls[0]!.url).not.toContain('ro-key-abc');
    expect(calls[0]!.init.method).toBe('POST');
    const body = new URLSearchParams(String(calls[0]!.init.body));
    expect(
      Object.fromEntries([...body.entries()].filter(([k]) => k !== 'custom_uptime_ranges')),
    ).toEqual({
      api_key: 'ro-key-abc',
      format: 'json',
      custom_uptime_ratios: '30-90',
      logs: '1',
      log_types: '1',
      logs_limit: '10',
      response_times: '1',
      response_times_average: '60',
      response_times_start_date: String(sec('2026-10-13T12:00:00Z')),
      response_times_end_date: String(sec('2026-10-15T12:00:00Z')),
      ssl: '1',
      limit: '5',
      monitors: '777001-777002',
    });
  });

  it('asks for the last 90 Riyadh days, oldest first, today ending now', () => {
    const days = stripRanges(NOW);
    expect(days).toHaveLength(90);
    // Today in Riyadh began at 21:00 UTC the day before.
    expect(days[89]).toEqual({
      day: '2026-10-15',
      start: Date.parse('2026-10-14T21:00:00Z'),
      end: NOW.getTime(),
    });
    expect(days[0]!.day).toBe('2026-07-18');
    expect(days[0]!.start).toBe(Date.parse('2026-07-17T21:00:00Z'));
    for (let i = 1; i < 90; i += 1) expect(days[i]!.start - days[i - 1]!.start).toBe(86_400_000);
    // 22:30 UTC is already the next day in Riyadh.
    expect(riyadhDay(Date.parse('2026-10-15T22:30:00Z'))).toBe('2026-10-16');
    const body = requestBody('k', undefined, NOW);
    const sent = body.get('custom_uptime_ranges')!.split('-');
    expect(sent).toHaveLength(90);
    expect(sent[89]).toBe(`${sec('2026-10-14T21:00:00Z')}_${sec('2026-10-15T12:00:00Z')}`);
    expect(body.has('monitors')).toBe(false);
  });

  it('accepts one to five ids joined by "-", and nothing else', async () => {
    for (const ok of ['1', '777001', '1-2-3-4-5', '123456789012'])
      expect(MONITOR_IDS.test(ok), ok).toBe(true);
    for (const bad of ['', '1-2-3-4-5-6', '1,2', '1 2', 'a', '1-', '-1', '1234567890123'])
      expect(MONITOR_IDS.test(bad), bad).toBe(false);
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const provider = uptimeRobot({ key: 'k', ids: '1,2', siteUrl: SITE, outbound: { fetchImpl } });
    await expect(provider.read(NOW)).rejects.toMatchObject({ reason: 'config' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is not set up without a key', () => {
    expect(uptimeProvider({ key: undefined, ids: undefined, siteUrl: SITE })).toBeNull();
    expect(uptimeProvider({ key: '  ', ids: undefined, siteUrl: SITE })).toBeNull();
    expect(uptimeProvider({ key: 'k', ids: undefined, siteUrl: SITE })?.name).toBe('UptimeRobot');
  });
});

describe('the answer', () => {
  it('all up: the ratios, the days, the response times oldest first, the certificate', () => {
    const r = readingOf(
      answer(monitor(), monitor({ id: 777002, friendly_name: 'Arabic', url: `${SITE}/ar/` })),
      NOW,
      SITE,
    );
    expect(r.ratio30).toBe(99.98);
    expect(r.ratio90).toBe(99.91);
    expect(r.days).toHaveLength(90);
    expect(r.days.every((d) => d.ratio === 100)).toBe(true);
    expect(r.days[89]!.day).toBe('2026-10-15');
    expect(r.responseTimes).toEqual([
      { at: '2026-10-15T10:00:00.000Z', ms: 190 },
      { at: '2026-10-15T11:00:00.000Z', ms: 210 },
    ]);
    expect(r.monitors).toEqual([
      { name: 'Home', path: '/', intervalSec: 300, status: 'up' },
      { name: 'Arabic', path: '/ar/', intervalSec: 300, status: 'up' },
    ]);
    expect(r.certificate).toEqual({ expires: '2026-12-14T00:00:00.000Z', issuer: "Let's Encrypt" });
    expect(r.downSince).toBeNull();
    expect(r.incidents).toEqual([]);
  });

  it('one down: its outage, when it began, the lowest ratio of the monitors', () => {
    const down = monitor({
      id: 777003,
      friendly_name: 'Health',
      url: `${SITE}/healthz`,
      status: 9,
      custom_uptime_ratio: '99.500-99.800',
      custom_uptime_ranges: `${ranges('100.000').slice(0, -7)}98.000`,
      logs: [
        {
          id: 51,
          type: 1,
          datetime: sec('2026-10-15T11:40:00Z'),
          duration: 1200,
          reason: { code: '522', detail: 'Connection Timeout' },
        },
        { id: 50, type: 2, datetime: sec('2026-10-14T10:00:00Z'), duration: 90000 },
        {
          id: 49,
          type: 1,
          datetime: sec('2026-10-01T03:00:00Z'),
          duration: 420,
          reason: { code: '500' },
        },
        { id: 48, type: 1, datetime: sec('2026-06-01T03:00:00Z'), duration: 60 },
      ],
    });
    const r = readingOf(answer(monitor(), down), NOW, SITE);
    expect(r.ratio30).toBe(99.5);
    expect(r.ratio90).toBe(99.8);
    expect(r.days[89]!.ratio).toBe(98);
    expect(r.days[88]!.ratio).toBe(100);
    expect(r.monitors[1]).toMatchObject({ path: '/healthz', status: 'down' });
    expect(r.downSince).toBe('2026-10-15T11:40:00.000Z');
    // Down events only (type 1), within 90 days, newest first; the reason as text.
    expect(r.incidents).toEqual([
      {
        id: '777003-51',
        start: '2026-10-15T11:40:00.000Z',
        durationSec: 1200,
        reason: 'Connection Timeout',
      },
      { id: '777003-49', start: '2026-10-01T03:00:00.000Z', durationSec: 420, reason: 'Error 500' },
    ]);
  });

  it('seems down counts as down; paused monitors are listed but leave the figures', () => {
    const seems = readingOf(answer(monitor({ status: 8 })), NOW, SITE);
    expect(seems.monitors[0]!.status).toBe('seems-down');
    const paused = readingOf(
      answer(monitor({ status: 0, custom_uptime_ratio: '10.000-10.000' }), monitor({ id: 2 })),
      NOW,
      SITE,
    );
    expect(paused.monitors.map((m) => m.status)).toEqual(['paused', 'up']);
    expect(paused.ratio30).toBe(99.98);
  });

  it('an API failure, or a body that is not the API’s, is a provider error', () => {
    expect(() =>
      readingOf(
        { stat: 'fail', error: { type: 'invalid_parameter', message: 'api_key is wrong' } },
        NOW,
        SITE,
      ),
    ).toThrow(UptimeProviderError);
    try {
      readingOf({ stat: 'fail', error: { message: 'api_key ro-key-abc not found' } }, NOW, SITE);
    } catch (err) {
      expect((err as UptimeProviderError).reason).toBe('api');
      expect((err as Error).message).not.toContain('ro-key-abc');
    }
    for (const body of [null, 'oops', [], { monitors: [] }]) {
      expect(() => readingOf(body, NOW, SITE), JSON.stringify(body)).toThrow(UptimeProviderError);
    }
  });

  it('without ssl the certificate is not reported (D3: Cloudflare renews it)', () => {
    expect(readingOf(answer(monitor({ ssl: undefined })), NOW, SITE).certificate).toBeNull();
    expect(readingOf(answer(monitor({ ssl: 'nonsense' })), NOW, SITE).certificate).toBeNull();
  });

  it('takes five monitors at most, and drops ones that do not parse', () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      monitor({ id: i + 1, friendly_name: `M${i}` }),
    );
    expect(readingOf(answer(...many), NOW, SITE).monitors).toHaveLength(5);
    expect(readingOf(answer({ id: 1 }, monitor()), NOW, SITE).monitors).toHaveLength(1);
  });

  it('shows a monitor on another host as such, never its address', () => {
    const r = readingOf(
      answer(
        monitor({ url: 'https://elsewhere.example.test/secret-path' }),
        monitor({ url: 'https://www.braiin-station.example.workers.dev/ar/' }),
      ),
      NOW,
      SITE,
    );
    expect(r.monitors[0]!.path).toBeNull();
    expect(JSON.stringify(r)).not.toContain('elsewhere');
    // `www.` aside, the same site.
    expect(r.monitors[1]!.path).toBe('/ar/');
  });

  it('caps the strings it keeps', () => {
    const r = readingOf(
      answer(
        monitor({
          friendly_name: 'n'.repeat(200),
          status: 9,
          logs: [
            {
              type: 1,
              datetime: sec('2026-10-15T11:00:00Z'),
              duration: 60,
              reason: { detail: 'r'.repeat(500) },
            },
          ],
        }),
      ),
      NOW,
      SITE,
    );
    expect(r.monitors[0]!.name).toHaveLength(60);
    expect(r.incidents[0]!.reason).toHaveLength(120);
  });
});
