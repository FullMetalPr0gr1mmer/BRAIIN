import { DEFAULT_TIME_ZONE, isStudioTimeZone } from '@schemas/timeZones';
import { toDate, zonedParts, type Instant, type ZonedParts } from '@/lib/time/zone';

// Dates and relative times for the admin (Admin v2 F4b, docs/admin-v2/ui.md AV-07): one
// clock for every screen, the studio's, in the admin's language (en-GB). Since Admin v2 U9 the
// studio's zone is a setting (`site_settings.timezone`, one of STUDIO_TIME_ZONES), so a clock
// is made for a zone: `clockFor(tz)`. There is deliberately no default clock to import: a
// server component asks `studioTimeZone(Astro.locals)` (src/lib/admin/studioTimeZone.ts), an
// island `useClock()` (src/components/admin/kit/clock.tsx), and a function that prints a
// date takes its caller's clock, so no screen can silently print Riyadh time.
//
// Why not toLocaleDateString(): it formats in the RUNTIME's zone and locale, so the Worker
// (UTC, en-US) and an editor's browser disagree about the date of anything stamped near
// midnight, and an island's server HTML and its hydrated render differ (a hydration
// mismatch). Here the zone is named, Intl supplies only NUMBERS (no month names, whose
// spelling varies between ICU builds: "Sep" or "Sept"), and the words are ours, so the
// Worker and every browser print the same string.
//
// The relative forms are the prototype's (`ago` and the CRM's due-date wording): "just
// now", "5 min ago", "3 h ago", "2 d ago", then the date; ahead of now, "in 5 min",
// "in 3 h" later today, "tomorrow", "in 4 d", then the date.

export { DEFAULT_TIME_ZONE, toDate, type Instant };
export const ADMIN_LOCALE = 'en-GB';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface DateOptions {
  /** 'auto' (the default) prints the year only when it is not `now`'s year. */
  year?: 'auto' | 'always';
  now?: Instant;
}

/** The admin's clock in one zone. */
export interface Clock {
  readonly zone: string;
  /** "12 Oct", or "12 Oct 2025" in another year (or always, with `year: 'always'`). */
  formatDate(at: Instant, options?: DateOptions): string;
  /** "14:05", the 24-hour clock. */
  formatTime(at: Instant): string;
  /** "12 Oct 2026, 14:05": the full moment, for a `<time>` element's title or a log row. */
  formatDateTime(at: Instant): string;
  /** How long ago (or how soon) a moment is, in words, against `now`. */
  relTime(at: Instant, now?: Instant): string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The calendar day as a day count, so two moments' days can be subtracted. */
function dayNumber(p: ZonedParts): number {
  return Date.UTC(p.year, p.month - 1, p.day) / DAY;
}

function makeClock(zone: string): Clock {
  const parts = (date: Date) => zonedParts(date, zone);

  const formatDate = (at: Instant, { year = 'auto', now = Date.now() }: DateOptions = {}) => {
    const date = toDate(at);
    if (!date) return '';
    const p = parts(date);
    const thisYear = parts(toDate(now) ?? new Date()).year;
    const day = `${p.day} ${MONTHS[p.month - 1]}`;
    return year === 'always' || p.year !== thisYear ? `${day} ${p.year}` : day;
  };

  const formatTime = (at: Instant) => {
    const date = toDate(at);
    if (!date) return '';
    const p = parts(date);
    return `${pad(p.hour)}:${pad(p.minute)}`;
  };

  const formatDateTime = (at: Instant) => {
    const date = toDate(at);
    if (!date) return '';
    return `${formatDate(date, { year: 'always' })}, ${formatTime(date)}`;
  };

  // A moment less than a minute either side of now is "just now", so a server clock a few
  // seconds ahead never reads "in 1 min". An invalid moment gives '' (the caller decides).
  const relTime = (at: Instant, now: Instant = Date.now()) => {
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
  };

  return { zone, formatDate, formatTime, formatDateTime, relTime };
}

const CLOCKS = new Map<string, Clock>();

/**
 * The admin's clock in `zone`, one per zone (made once: its formatter is the expensive part).
 * A zone outside the studio's closed list is read as the default, as the settings reader does.
 */
export function clockFor(zone: string | null | undefined): Clock {
  const tz = isStudioTimeZone(zone) ? zone : DEFAULT_TIME_ZONE;
  let clock = CLOCKS.get(tz);
  if (!clock) {
    clock = makeClock(tz);
    CLOCKS.set(tz, clock);
  }
  return clock;
}

/** The ISO string for a `<time datetime>` attribute ('' when the moment is invalid). */
export function isoOf(at: Instant): string {
  return toDate(at)?.toISOString() ?? '';
}
