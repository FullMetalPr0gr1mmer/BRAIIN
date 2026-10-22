// Calendar arithmetic in a named time zone (Admin v2 U9): the studio's zone
// (`site_settings.timezone`, one of STUDIO_TIME_ZONES) decides what "today", "midnight" and
// "12 Oct, 14:05" mean across the admin and for maintenance's "Back on". Pure: no DOM, no
// clock unless one is passed, so the Worker and every browser agree.
//
// Intl supplies only NUMBERS (formatToParts with a fixed en-GB locale and h23), never words,
// whose spelling varies between ICU builds. One formatter per zone, made once: building an
// Intl.DateTimeFormat costs far more CPU than using one, and the Worker has 10 ms a request.

export type Instant = Date | string | number;

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = FORMATTERS.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
    });
    FORMATTERS.set(tz, f);
  }
  return f;
}

/** The instant as a Date, or null when it is not a valid moment. */
export function toDate(at: Instant | null | undefined): Date | null {
  if (at === null || at === undefined || at === '') return null;
  const date = at instanceof Date ? new Date(at.getTime()) : new Date(at);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The wall-clock reading of `at` in `tz`. */
export function zonedParts(at: Instant, tz: string): ZonedParts {
  const date = toDate(at) ?? new Date(0);
  const out: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(date)) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return {
    year: out['year'] ?? 1970,
    month: out['month'] ?? 1,
    day: out['day'] ?? 1,
    // h23 keeps midnight at 0; an engine that still says 24 is read as 0.
    hour: (out['hour'] ?? 0) % 24,
    minute: out['minute'] ?? 0,
    second: out['second'] ?? 0,
  };
}

/** How far `tz`'s wall clock is ahead of UTC at `ms`, in milliseconds. */
export function zoneOffsetMs(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // The formatter drops the milliseconds; so does the comparison.
  return wall - (ms - (((ms % 1000) + 1000) % 1000));
}

/**
 * The instant a wall-clock time in `tz` happens. Two passes of offset correction: the first
 * guess uses the offset at the UTC reading, the second the offset at that guess, which is
 * right on either side of a DST change (London's, Cairo's). A wall time a spring-forward
 * skips (it never happens) resolves to the instant after the gap.
 */
export function zonedInstant(
  tz: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const first = wall - zoneOffsetMs(wall, tz);
  const second = wall - zoneOffsetMs(first, tz);
  if (second === first) return new Date(first);
  // The offsets disagree: the wall time sits in a gap or an overlap. Take the later reading
  // that is consistent, which is the post-transition one.
  const third = wall - zoneOffsetMs(second, tz);
  return new Date(Math.max(second, third));
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayParts(day: string): [number, number, number] {
  const m = DAY_RE.exec(day);
  if (!m) throw new RangeError(`not a day: ${day}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** The first instant of calendar day 'YYYY-MM-DD' in `tz` (its midnight). */
export function zonedDayStart(day: string, tz: string): Date {
  const [y, m, d] = dayParts(day);
  return zonedInstant(tz, y, m, d);
}

/** The first instant of the NEXT day in `tz`: a day is [start, end). */
export function zonedDayEnd(day: string, tz: string): Date {
  const [y, m, d] = dayParts(day);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return zonedInstant(tz, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The calendar day 'YYYY-MM-DD' that `at` falls on in `tz`. */
export function dayKeyIn(at: Instant, tz: string): string {
  const p = zonedParts(at, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Today in `tz`, 'YYYY-MM-DD'. */
export function todayIn(tz: string, now: Instant = Date.now()): string {
  return dayKeyIn(now, tz);
}

/** The day `n` calendar days after `day` (negative: before). Pure calendar arithmetic. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = dayParts(day);
  const next = new Date(Date.UTC(y, m - 1, d + n));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}
