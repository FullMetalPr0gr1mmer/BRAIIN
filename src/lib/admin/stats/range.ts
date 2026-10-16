// The stats screens' date ranges (Admin v2 U2, docs/admin-v2/ui.md "Website stats v1"): the
// last 7, 30 or 90 days, chosen by `?range=` links, in UTC days as the rollups count them
// (rollup_daily_pageviews and rollup_daily_vitals, migrations 0002 and 0052: a day runs
// midnight to midnight UTC, 3 am to 3 am in Riyadh). The range ends today, so today's
// partial day is in it; the previous period is the same number of days just before.

export const STAT_RANGES = [7, 30, 90] as const;
export type StatRange = (typeof STAT_RANGES)[number];

/** What a stats screen shows with no `?range=`, or a value that is not one of the three. */
export const DEFAULT_RANGE: StatRange = 30;

/** The query parameter the range links set. */
export const RANGE_PARAM = 'range';

export interface DateRange {
  /** One of STAT_RANGES on the screens; any 1 to 90 for the JSON routes' `?days=`. */
  days: number;
  /** First and last UTC day of the range, both included (YYYY-MM-DD). */
  from: string;
  to: string;
  /** The previous period: the same number of days, ending the day before `from`. */
  prevFrom: string;
  prevTo: string;
}

const DAY_MS = 86_400_000;

/** A UTC day as YYYY-MM-DD. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The UTC day `days` after (or, negative, before) a YYYY-MM-DD day. */
export function addDays(day: string, days: number): string {
  return utcDay(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS);
}

/** The range a value names: one of STAT_RANGES, else the default. */
export function rangeParam(value: string | null | undefined): StatRange {
  const n = Number(value);
  return (STAT_RANGES as readonly number[]).includes(n) ? (n as StatRange) : DEFAULT_RANGE;
}

/** The range a stats URL asks for, ending today (UTC). */
export function rangeFrom(url: URL | URLSearchParams, now: number = Date.now()): DateRange {
  const params = url instanceof URL ? url.searchParams : url;
  return rangeOfDays(rangeParam(params.get(RANGE_PARAM)), now);
}

/** The last `days` UTC days, today included, and the period before them. */
export function rangeOfDays(days: number, now: number = Date.now()): DateRange {
  const to = utcDay(now);
  const from = addDays(to, -(days - 1));
  const prevTo = addDays(from, -1);
  return { days, from, to, prevFrom: addDays(prevTo, -(days - 1)), prevTo };
}

/**
 * True when the rollups reach back over the whole previous period: their first day is on or
 * before it starts. Only then is a change against the previous period shown; a period the
 * counting had not started for would read as growth from nothing.
 */
export function hasPreviousPeriod(firstDay: string | null | undefined, range: DateRange): boolean {
  return typeof firstDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(firstDay)
    ? firstDay <= range.prevFrom
    : false;
}

/** Every UTC day of a range, in order. */
export function daysOf(range: Pick<DateRange, 'from' | 'to'>): string[] {
  const out: string[] = [];
  for (let day = range.from; day <= range.to; day = addDays(day, 1)) out.push(day);
  return out;
}

/** "the previous 30 days": what a KPI's change is measured against, in words. */
export function periodLabel(range: Pick<DateRange, 'days'>): string {
  return `the previous ${range.days} days`;
}

/** A stats URL with one parameter changed; the first page and the default range drop out. */
export function statsHref(
  path: string,
  current: URL | URLSearchParams,
  changes: Record<string, string | null>,
): string {
  const params = new URLSearchParams(current instanceof URL ? current.searchParams : current);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  if (params.get(RANGE_PARAM) === String(DEFAULT_RANGE)) params.delete(RANGE_PARAM);
  // A new range or tab starts a list on its first page.
  if (!('page' in changes)) params.delete('page');
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

const DAY_LABEL = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

/** "1 Oct": a UTC day as a chart label (the day the rollup counted, not a local one). */
export function dayLabel(day: string): string {
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(ms) ? DAY_LABEL.format(ms) : day;
}
