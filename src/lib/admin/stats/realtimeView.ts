import { timeZoneCity } from '@schemas/timeZones';
import type { Clock } from '@/lib/admin/relTime';

// Realtime on the website stats (Admin v2 G1b), the shape the screen and its island share.
// Pure: the Realtime tab renders it on the server first, then the island (AdminRealtime)
// re-reads GET /api/admin/analytics/realtime and parses the answer with the same function,
// so the server's first paint and every update say the same thing in the same words.
//
// The figures come from rollup_minute_activity (migration 0071), written every minute by
// pg_cron (app.rollup_realtime) and kept 48 hours: "active" is a visit (one tab) with any
// event in the five minutes ending with the latest complete minute, from visitors who
// accepted analytics cookies only.

/** How long a visit counts as active after its last event. */
export const ACTIVE_MINUTES = 5;
/** The per-minute chart's span. */
export const MINUTES_SHOWN = 30;
/** How often the island asks again, while the tab is visible and not paused. */
export const REALTIME_POLL_MS = 60_000;
/** The island stops asking by itself after this long (P-15's request budget). */
export const REALTIME_AUTO_STOP_MS = 30 * 60_000;
/** How long the minute rollup keeps its rows. */
export const REALTIME_KEEP_HOURS = 48;

export interface RealtimeView {
  /** The latest complete minute (ISO), or null when the answer carried none. */
  asOf: string | null;
  activeVisits: number;
  /** Up to ten pages the active visits are on, the most first. */
  topPaths: { path: string; visits: number }[];
  /** Page views per minute, oldest first, a minute with none as 0. */
  perMinute: { minute: string; views: number }[];
}

const whole = (value: unknown): number => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

const rows = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
    : [];

/** realtime_summary's answer (or the JSON route's), read leniently. */
export function realtimeOf(raw: unknown): RealtimeView {
  const data =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const asOf = data['as_of'] ?? data['asOf'];
  return {
    asOf: typeof asOf === 'string' && Number.isFinite(Date.parse(asOf)) ? asOf : null,
    activeVisits: whole(data['active_visits'] ?? data['activeVisits']),
    topPaths: rows(data['top_paths'] ?? data['topPaths']).flatMap((row) =>
      typeof row['path'] === 'string'
        ? [{ path: row['path'].slice(0, 200), visits: whole(row['visits']) }]
        : [],
    ),
    perMinute: rows(data['per_minute'] ?? data['perMinute'])
      .flatMap((row) =>
        typeof row['minute'] === 'string' && Number.isFinite(Date.parse(row['minute']))
          ? [{ minute: row['minute'], views: whole(row['views']) }]
          : [],
      )
      .slice(-MINUTES_SHOWN),
  };
}

/** "Riyadh time": the studio's zone named by its city (Admin v2 U9). */
export const zoneWords = (clock: Clock): string => `${timeZoneCity(clock.zone)} time`;

/**
 * "Updated 14:05, Riyadh time" on the studio's clock, or nothing to say when the answer
 * named no minute.
 */
export function updatedLine(view: RealtimeView, clock: Clock): string {
  return view.asOf ? `Updated ${clock.formatTime(view.asOf)}, ${zoneWords(clock)}` : '';
}

/** The minute's label on the chart and in its table: "14:05", on the studio's clock. */
export const minuteLabel = (minute: string, clock: Clock): string => clock.formatTime(minute);

/** "1 person" / "7 people". */
export function peopleWord(n: number): string {
  return n === 1 ? 'person' : 'people';
}
