// Dates and relative times for the admin (Admin v2 F4b, docs/admin-v2/ui.md AV-07): one
// clock for every screen, the studio's (Asia/Riyadh), in the admin's language (en-GB).
//
// Why not toLocaleDateString(): it formats in the RUNTIME's zone and locale, so the Worker
// (UTC, en-US) and an editor's browser disagree about the date of anything stamped near
// midnight, and an island's server HTML and its hydrated render differ (a hydration
// mismatch). Here the zone is fixed, Intl supplies only NUMBERS (no month names, whose
// spelling varies between ICU builds: "Sep" or "Sept"), and the words are ours, so the
// Worker and every browser print the same string.
//
// The relative forms are the prototype's (`ago` and the CRM's due-date wording): "just
// now", "5 min ago", "3 h ago", "2 d ago", then the date; ahead of now, "in 5 min",
// "in 3 h" later today, "tomorrow", "in 4 d", then the date.

export const ADMIN_TIME_ZONE = 'Asia/Riyadh';
export const ADMIN_LOCALE = 'en-GB';

/** A moment: a Date, an ISO string (what the API returns) or epoch milliseconds. */
export type Instant = Date | string | number;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Numbers only, in the studio's zone. `h23` keeps midnight at 00, never 24.
const PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: ADMIN_TIME_ZONE,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  hourCycle: 'h23',
});

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** The instant as a Date, or null when it is not a valid moment. */
export function toDate(at: Instant | null | undefined): Date | null {
  if (at === null || at === undefined || at === '') return null;
  const date = at instanceof Date ? new Date(at.getTime()) : new Date(at);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parts(date: Date): Parts {
  const out: Record<string, number> = {};
  for (const part of PARTS.formatToParts(date)) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return {
    year: out['year'] ?? 0,
    month: out['month'] ?? 1,
    day: out['day'] ?? 1,
    hour: out['hour'] ?? 0,
    minute: out['minute'] ?? 0,
  };
}

/** The studio's calendar day as a day count, so two moments' days can be subtracted. */
function dayNumber(p: Parts): number {
  return Date.UTC(p.year, p.month - 1, p.day) / DAY;
}

const pad = (n: number) => String(n).padStart(2, '0');

export interface DateOptions {
  /** 'auto' (the default) prints the year only when it is not `now`'s year. */
  year?: 'auto' | 'always';
  now?: Instant;
}

/** "12 Oct", or "12 Oct 2025" in another year (or always, with `year: 'always'`). */
export function formatDate(at: Instant, { year = 'auto', now = Date.now() }: DateOptions = {}) {
  const date = toDate(at);
  if (!date) return '';
  const p = parts(date);
  const thisYear = parts(toDate(now) ?? new Date()).year;
  const day = `${p.day} ${MONTHS[p.month - 1]}`;
  return year === 'always' || p.year !== thisYear ? `${day} ${p.year}` : day;
}

/** "14:05", the 24-hour clock in the studio's zone. */
export function formatTime(at: Instant): string {
  const date = toDate(at);
  if (!date) return '';
  const p = parts(date);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** "12 Oct 2026, 14:05": the full moment, for a `<time>` element's title or a log row. */
export function formatDateTime(at: Instant): string {
  const date = toDate(at);
  if (!date) return '';
  return `${formatDate(date, { year: 'always' })}, ${formatTime(date)}`;
}

/** The ISO string for a `<time datetime>` attribute ('' when the moment is invalid). */
export function isoOf(at: Instant): string {
  return toDate(at)?.toISOString() ?? '';
}

/**
 * How long ago (or how soon) a moment is, in words, against `now`. A moment less than a
 * minute either side of now is "just now", so a server clock a few seconds ahead never
 * reads "in 1 min". An invalid moment gives '' (the caller decides what to show).
 */
export function relTime(at: Instant, now: Instant = Date.now()): string {
  const date = toDate(at);
  const ref = toDate(now);
  if (!date || !ref) return '';
  const diff = ref.getTime() - date.getTime();
  if (Math.abs(diff) < MINUTE) return 'just now';

  if (diff > 0) {
    const minutes = Math.floor(diff / MINUTE);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(diff / HOUR);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.floor(diff / DAY);
    if (days < 7) return `${days} d ago`;
    return formatDate(date, { now: ref });
  }

  const ahead = -diff;
  const minutes = Math.floor(ahead / MINUTE);
  if (minutes < 60) return `in ${minutes} min`;
  const days = dayNumber(parts(date)) - dayNumber(parts(ref));
  if (days === 0) return `in ${Math.floor(ahead / HOUR)} h`;
  if (days === 1) return 'tomorrow';
  if (days < 7) return `in ${days} d`;
  return formatDate(date, { now: ref });
}
