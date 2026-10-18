import type { Monitor, UptimeDay } from '@schemas/healthProbe';
import type { ChartTable } from '../charts';
import { formatDate } from '../relTime';
import { formatRatio } from './probes';

// The Uptime card's pure parts (Admin v2 G2): the 90-day strip's day states, its table
// alternative and one-line summary (one dataset, so the words never drift from the bars),
// the monitors' interval in words, and the paths the standard asks the monitor to watch.

/** A day on the strip: up all day, down a few minutes, down longer, or no reading. */
export type DayState = 'ok' | 'dip' | 'down' | 'none';

/** A day's state: 100% up; 99% or more (down for up to 14 minutes); less; no reading. */
export function dayState(ratio: number | null): DayState {
  if (ratio === null) return 'none';
  if (ratio >= 100) return 'ok';
  if (ratio >= 99) return 'dip';
  return 'down';
}

export const DAY_STATE_WORDS: Readonly<Record<DayState, string>> = {
  ok: 'Up all day',
  dip: 'Down for a few minutes',
  down: 'Down for over 14 minutes',
  none: 'No reading',
};

/** "Up all day on 88 of 90 days", with the days that had no reading when there are any. */
export function stripSummary(days: readonly UptimeDay[]): string {
  const up = days.filter((d) => dayState(d.ratio) === 'ok').length;
  const none = days.filter((d) => dayState(d.ratio) === 'none').length;
  const base = `Up all day on ${up} of ${days.length} days`;
  return none > 0 ? `${base}; no reading on ${none}.` : `${base}.`;
}

/** The strip as a table: the days with downtime only, newest first (Riyadh days). */
export function stripTable(days: readonly UptimeDay[]): ChartTable {
  const rows = days
    .filter((d) => {
      const state = dayState(d.ratio);
      return state === 'dip' || state === 'down';
    })
    .reverse()
    .map((d) => [
      formatDate(`${d.day}T12:00:00+03:00`, { year: 'always' }),
      formatRatio(d.ratio ?? 0),
      DAY_STATE_WORDS[dayState(d.ratio)],
    ]);
  return {
    head: ['Day (Riyadh)', 'Uptime', 'What happened'],
    rows: rows.length > 0 ? rows : [['No day with downtime', '', '']],
  };
}

/** "every 5 minutes", from the most frequent monitor; null when none reports one. */
export function intervalWords(monitors: readonly Monitor[]): string | null {
  const intervals = monitors.map((m) => m.intervalSec).filter((s) => s > 0);
  if (intervals.length === 0) return null;
  const s = Math.min(...intervals);
  if (s < 60) return `every ${s} seconds`;
  const minutes = Math.round(s / 60);
  if (minutes === 1) return 'every minute';
  if (minutes < 60) return `every ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? 'every hour' : `every ${hours} hours`;
}

/** The paths CLAUDE.md §10 asks the external monitor to watch. */
export const WATCHED_PATHS = ['/', '/ar/', '/healthz'] as const;

const norm = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path);

/** The standard's paths no monitor watches on this site. */
export function unwatched(monitors: readonly Monitor[]): string[] {
  const watched = new Set(
    monitors.filter((m) => m.path !== null).map((m) => norm(m.path as string)),
  );
  return WATCHED_PATHS.filter((p) => !watched.has(norm(p)));
}

/** "/, /ar/ and /healthz". */
export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
