import { z } from 'zod';
import { PROBE_CAPS, type Monitor, type MonitorStatus } from '@schemas/healthProbe';
import { DEFAULT_TIME_ZONE } from '@schemas/timeZones';
import { outboundJson, type OutboundOptions } from '@/lib/http/outbound';
import { addDays, todayIn, zoneOffsetMs, zonedDayStart } from '@/lib/time/zone';
import {
  UptimeProviderError,
  type UptimeIncident,
  type UptimeProvider,
  type UptimeReading,
} from './types';

// The UptimeRobot adapter (Admin v2 G2, decision D1): its legacy v2 API, `getMonitors`,
// verified against https://uptimerobot.com/api/legacy/ on 2026-10-18. One POST per reading,
// with the account's READ-ONLY key ("Read-only: all get* endpoints") in the form body, never
// in the URL:
//
//   custom_uptime_ratios=30-90          the 30- and 90-day uptime, "99.980-99.910"
//   custom_uptime_ranges=<90 ranges>    one per studio day (its zone, Admin v2 U9),
//                                       "<start>_<end>" in Unix seconds,
//                                       joined by "-"; the answer is one ratio per range
//   logs=1&log_types=1&logs_limit=10    the 10 newest down events (type 1) per monitor
//   response_times=1                    the time to first byte, averaged per 60 minutes over
//   &response_times_average=60          the last 48 hours (the span may be at most 7 days)
//   &response_times_start_date/_end_date
//   ssl=1                               the certificate, where the account's plan has it
//   monitors=<ids>                      UPTIME_MONITOR_IDS when set, else the account's first
//   limit=5                             five monitors
//
// Monitor status: 0 paused, 1 not checked yet, 2 up, 8 seems down, 9 down. Log type: 1 down,
// 2 up, 98 started, 99 paused. `stat` is "ok" or "fail". Everything is parsed leniently with
// Zod (unknown fields dropped, numbers that arrive as strings accepted), and a monitor's URL
// is reduced to its path, or to null when its host is not this site's (shown as "another
// address"): no other address is ever printed.

const ENDPOINT = 'https://api.uptimerobot.com/v2/getMonitors';

/** The grammar of UPTIME_MONITOR_IDS: one to five monitor ids joined by "-". */
export const MONITOR_IDS = /^\d{1,12}(-\d{1,12}){0,4}$/;

const DAY_MS = 86_400_000;
const STRIP_DAYS = PROBE_CAPS.days;
const LOG_WINDOW_MS = 90 * DAY_MS;
const RESPONSE_HOURS = PROBE_CAPS.responseTimes;

const STATUS: Readonly<Record<number, MonitorStatus>> = {
  0: 'paused',
  1: 'not-checked',
  2: 'up',
  8: 'seems-down',
  9: 'down',
};

const num = z.coerce.number().finite();
const LogSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  type: num,
  datetime: num,
  duration: num.optional(),
  reason: z
    .object({ code: z.union([z.string(), z.number()]).optional(), detail: z.string().optional() })
    .partial()
    .optional()
    .catch(undefined),
});
const MonitorSchema = z.object({
  id: z.union([z.number(), z.string()]),
  friendly_name: z.string().catch(''),
  url: z.string().catch(''),
  interval: num.catch(0),
  status: num,
  custom_uptime_ratio: z.string().optional().catch(undefined),
  custom_uptime_ranges: z.string().optional().catch(undefined),
  logs: z.array(z.unknown()).optional().catch(undefined),
  response_times: z.array(z.unknown()).optional().catch(undefined),
  ssl: z
    .object({
      brand: z.string().optional(),
      product: z.string().optional(),
      expires: num.optional(),
    })
    .partial()
    .optional()
    .catch(undefined),
});
const ResponseSchema = z.object({
  stat: z.string(),
  monitors: z.array(z.unknown()).optional(),
});
const PointSchema = z.object({ datetime: num, value: num });

type RobotMonitor = z.infer<typeof MonitorSchema>;

/**
 * The last 90 days of the studio's calendar (its zone, `site_settings.timezone`: Admin v2 U9),
 * oldest first, as [start, end) in ms; today's ends at `now`.
 *
 * CPU (the cron has 10 ms): each Intl reading costs about 12 µs, so the days are not each
 * asked of Intl. The zone's offset is read at both ends of the window; a listed zone changes
 * its offset at most twice a year, months apart, so equal ends mean no change inside and every
 * midnight is plain arithmetic. Otherwise (a window that holds London's or Cairo's change)
 * each midnight is asked once.
 */
export function stripRanges(
  now: Date,
  tz: string = DEFAULT_TIME_ZONE,
): { day: string; start: number; end: number }[] {
  const today = todayIn(tz, now);
  const days = Array.from({ length: STRIP_DAYS + 1 }, (_, i) =>
    addDays(today, i - (STRIP_DAYS - 1)),
  );
  const first = Date.parse(`${days[0]}T00:00:00Z`);
  const offsetNow = zoneOffsetMs(now.getTime(), tz);
  const steady = zoneOffsetMs(first - offsetNow, tz) === offsetNow;
  const startOf = (day: string) =>
    steady ? Date.parse(`${day}T00:00:00Z`) - offsetNow : zonedDayStart(day, tz).getTime();
  const starts = days.map(startOf);
  const out: { day: string; start: number; end: number }[] = [];
  for (let i = 0; i < STRIP_DAYS; i += 1) {
    const start = starts[i]!;
    out.push({ day: days[i]!, start, end: Math.min(starts[i + 1]!, now.getTime()) });
  }
  return out;
}

/** The form body: the key, then the parameters above. Exported for the fixtures' test. */
export function requestBody(
  key: string,
  ids: string | undefined,
  now: Date,
  tz?: string,
): URLSearchParams {
  const seconds = (ms: number) => String(Math.floor(ms / 1000));
  const body = new URLSearchParams({
    api_key: key,
    format: 'json',
    custom_uptime_ratios: '30-90',
    custom_uptime_ranges: stripRanges(now, tz)
      .map((r) => `${seconds(r.start)}_${seconds(r.end)}`)
      .join('-'),
    logs: '1',
    log_types: '1',
    logs_limit: String(PROBE_CAPS.incidents),
    response_times: '1',
    response_times_average: '60',
    response_times_start_date: seconds(now.getTime() - RESPONSE_HOURS * 3_600_000),
    response_times_end_date: seconds(now.getTime()),
    ssl: '1',
    limit: String(PROBE_CAPS.monitors),
  });
  if (ids) body.set('monitors', ids);
  return body;
}

const ratioList = (raw: string | undefined): (number | null)[] =>
  (raw ?? '').split('-').map((part) => {
    const value = Number(part);
    return part.trim() !== '' && Number.isFinite(value) && value >= 0 && value <= 100
      ? value
      : null;
  });

const lowest = (values: (number | null | undefined)[]): number | null => {
  const known = values.filter((v): v is number => typeof v === 'number');
  return known.length > 0 ? Math.min(...known) : null;
};

const host = (raw: string): string | null => {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
};

/** The monitor as the screens show it: its path on this site, or null for another address. */
function monitorOf(m: RobotMonitor, siteHost: string | null): Monitor {
  let path: string | null = null;
  if (siteHost !== null && host(m.url) === siteHost) {
    try {
      path = new URL(m.url).pathname || '/';
    } catch {
      path = null;
    }
  }
  return {
    name: m.friendly_name.slice(0, PROBE_CAPS.monitorName),
    path: path === null ? null : path.slice(0, PROBE_CAPS.monitorPath),
    intervalSec: Math.max(0, Math.min(86_400, Math.round(m.interval))),
    status: STATUS[m.status] ?? 'not-checked',
  };
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

/** Normalises getMonitors' answer. Exported for the fixture tests. */
export function readingOf(
  json: unknown,
  now: Date,
  siteUrl: string,
  tz?: string,
): UptimeReading {
  const top = ResponseSchema.safeParse(json);
  if (!top.success) throw new UptimeProviderError('shape');
  if (top.data.stat !== 'ok') throw new UptimeProviderError('api');
  const monitors = (top.data.monitors ?? [])
    .map((raw) => MonitorSchema.safeParse(raw))
    .filter((p) => p.success)
    .map((p) => p.data)
    .slice(0, PROBE_CAPS.monitors);
  const siteHost = host(siteUrl);
  const shown = monitors.map((m) => monitorOf(m, siteHost));
  const live = monitors.filter((m) => m.status !== 0);

  const ratios = live.map((m) => ratioList(m.custom_uptime_ratio));
  const ranges = live.map((m) => ratioList(m.custom_uptime_ranges));
  const days = stripRanges(now, tz).map((r, i) => ({
    day: r.day,
    ratio: lowest(ranges.map((list) => list[i])),
  }));

  const since = now.getTime() - LOG_WINDOW_MS;
  const incidents: UptimeIncident[] = [];
  let downSince: number | null = null;
  for (const m of monitors) {
    const down = m.status === 8 || m.status === 9;
    for (const raw of m.logs ?? []) {
      const log = LogSchema.safeParse(raw);
      if (!log.success || log.data.type !== 1) continue;
      const startMs = log.data.datetime * 1000;
      if (down && (downSince === null || startMs > downSince)) downSince = startMs;
      if (startMs < since || startMs > now.getTime()) continue;
      const detail = log.data.reason?.detail?.trim();
      const code = log.data.reason?.code;
      incidents.push({
        id: `${String(m.id)}-${String(log.data.id ?? log.data.datetime)}`.slice(0, 40),
        start: iso(log.data.datetime),
        durationSec: Math.max(0, Math.min(366 * 86_400, Math.round(log.data.duration ?? 0))),
        reason: (detail || (code !== undefined ? `Error ${String(code)}` : 'Down')).slice(
          0,
          PROBE_CAPS.reason,
        ),
      });
    }
  }
  incidents.sort((a, b) => Date.parse(b.start) - Date.parse(a.start) || a.id.localeCompare(b.id));
  const anyDown = monitors.some((m) => m.status === 8 || m.status === 9);

  const first = monitors[0];
  const responseTimes = (first?.response_times ?? [])
    .map((raw) => PointSchema.safeParse(raw))
    .filter((p) => p.success)
    .map((p) => ({ at: iso(p.data.datetime), ms: Math.max(0, Math.min(600_000, p.data.value)) }))
    .filter((p) => Date.parse(p.at) <= now.getTime())
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(-RESPONSE_HOURS);

  const withCert = monitors.find((m) => typeof m.ssl?.expires === 'number' && m.ssl.expires > 0);
  const certificate =
    withCert?.ssl?.expires !== undefined
      ? {
          expires: iso(withCert.ssl.expires),
          issuer:
            (withCert.ssl.brand || withCert.ssl.product || '').slice(0, PROBE_CAPS.issuer) || null,
        }
      : null;

  return {
    ratio30: lowest(ratios.map((r) => r[0])),
    ratio90: lowest(ratios.map((r) => r[1])),
    days,
    incidents: incidents.slice(0, PROBE_CAPS.incidents),
    responseTimes,
    monitors: shown,
    certificate,
    downSince: anyDown && downSince !== null ? new Date(downSince).toISOString() : null,
  };
}

export interface UptimeRobotConfig {
  key: string;
  ids: string | undefined;
  siteUrl: string;
  /** Seams for tests. */
  outbound?: OutboundOptions;
}

export function uptimeRobot(config: UptimeRobotConfig): UptimeProvider {
  return {
    name: 'UptimeRobot',
    async read(now, tz) {
      const ids = config.ids?.trim() || undefined;
      if (ids !== undefined && !MONITOR_IDS.test(ids)) throw new UptimeProviderError('config');
      const { json } = await outboundJson(
        ENDPOINT,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
            'cache-control': 'no-cache',
          },
          body: requestBody(config.key, ids, now, tz).toString(),
        },
        config.outbound,
      );
      return readingOf(json, now, config.siteUrl, tz);
    },
  };
}
