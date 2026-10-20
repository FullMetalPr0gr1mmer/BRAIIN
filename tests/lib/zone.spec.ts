import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIME_ZONE,
  STUDIO_TIME_ZONES,
  isStudioTimeZone,
  timeZoneCity,
} from '@schemas/timeZones';
import { StudioTimeZoneSchema } from '@schemas/settings';
import {
  addDays,
  dayKeyIn,
  todayIn,
  zoneOffsetMs,
  zonedDayEnd,
  zonedDayStart,
  zonedInstant,
  zonedParts,
} from '@/lib/time/zone';

// The studio's time zone (Admin v2 U9): the closed list, held equal to both database CHECKs,
// and the calendar arithmetic every "today", "midnight" and day bound uses, across London's and
// Cairo's daylight saving.

const ZONES = STUDIO_TIME_ZONES.map((z) => z.value);
const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');

/** The quoted zones of the last CHECK in the migrations that names `constraint` (or column). */
function checkList(pattern: RegExp): string[] {
  let found: string[] | null = null;
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    for (const m of sql.matchAll(pattern)) {
      found = [...(m[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]!);
    }
  }
  if (!found) throw new Error(`no CHECK matches ${pattern}`);
  return found;
}

describe('the closed list (STUDIO_TIME_ZONES)', () => {
  it('equals site_settings_timezone_closed (0075) and crm_settings’ CHECK (0035), in order', () => {
    expect(
      checkList(/constraint site_settings_timezone_closed check \(timezone in \(([^)]*)\)\)/g),
    ).toEqual(ZONES);
    expect(
      checkList(/timezone text not null default 'Asia\/Riyadh' check \(timezone in \(([^)]*)\)\)/g),
    ).toEqual(ZONES);
  });

  it('is ten real zones, Riyadh first and the default, each named by its city', () => {
    expect(ZONES).toHaveLength(10);
    expect(ZONES[0]).toBe(DEFAULT_TIME_ZONE);
    for (const zone of ZONES) {
      expect(() => new Intl.DateTimeFormat('en-GB', { timeZone: zone }), zone).not.toThrow();
      expect(timeZoneCity(zone)).not.toBe(zone);
    }
    expect(timeZoneCity('Asia/Qatar')).toBe('Doha');
    expect(timeZoneCity('UTC')).toBe('UTC (no offset)');
  });

  it('the schema and the guard take exactly the list', () => {
    for (const zone of ZONES) {
      expect(StudioTimeZoneSchema.safeParse(zone).success).toBe(true);
      expect(isStudioTimeZone(zone)).toBe(true);
    }
    for (const other of ['Europe/Paris', 'asia/riyadh', '', 'Asia/Riyadh ', 42, null]) {
      expect(StudioTimeZoneSchema.safeParse(other).success).toBe(false);
      expect(isStudioTimeZone(other)).toBe(false);
    }
  });
});

describe('zonedParts and the offsets', () => {
  it('reads the wall clock, midnight as 0', () => {
    expect(zonedParts('2026-10-14T21:00:00Z', 'Asia/Riyadh')).toEqual({
      year: 2026,
      month: 10,
      day: 15,
      hour: 0,
      minute: 0,
      second: 0,
    });
    expect(zonedParts('2026-10-14T21:00:00Z', 'Asia/Dubai').hour).toBe(1);
    expect(zonedParts('2026-10-14T21:00:00Z', 'UTC').day).toBe(14);
  });

  it('knows each zone’s offset, summer and winter', () => {
    const jan = Date.UTC(2026, 0, 15, 12);
    const jul = Date.UTC(2026, 6, 15, 12);
    const h = 3_600_000;
    expect(zoneOffsetMs(jan, 'Asia/Riyadh')).toBe(3 * h);
    expect(zoneOffsetMs(jul, 'Asia/Riyadh')).toBe(3 * h);
    expect(zoneOffsetMs(jan, 'Asia/Dubai')).toBe(4 * h);
    expect(zoneOffsetMs(jan, 'Europe/London')).toBe(0);
    expect(zoneOffsetMs(jul, 'Europe/London')).toBe(1 * h);
    expect(zoneOffsetMs(jan, 'Africa/Cairo')).toBe(2 * h);
    expect(zoneOffsetMs(jul, 'Africa/Cairo')).toBe(3 * h);
    expect(zoneOffsetMs(jan, 'UTC')).toBe(0);
  });
});

describe('zonedDayStart / zonedDayEnd: a day is [its midnight, the next midnight)', () => {
  it('every zone on an ordinary day', () => {
    for (const zone of ZONES) {
      const start = zonedDayStart('2026-10-15', zone);
      const end = zonedDayEnd('2026-10-15', zone);
      expect(dayKeyIn(start, zone), zone).toBe('2026-10-15');
      expect(zonedParts(start, zone), zone).toMatchObject({ hour: 0, minute: 0 });
      expect(dayKeyIn(start.getTime() - 1, zone), zone).toBe('2026-10-14');
      expect(dayKeyIn(end.getTime() - 1, zone), zone).toBe('2026-10-15');
      expect(dayKeyIn(end, zone), zone).toBe('2026-10-16');
    }
    expect(zonedDayStart('2026-10-15', 'Asia/Riyadh').toISOString()).toBe(
      '2026-10-14T21:00:00.000Z',
    );
    expect(zonedDayStart('2026-10-15', 'UTC').toISOString()).toBe('2026-10-15T00:00:00.000Z');
  });

  it('London: the spring day is 23 hours, the autumn day 25, each starting at its midnight', () => {
    const spring = zonedDayStart('2026-03-29', 'Europe/London');
    expect(spring.toISOString()).toBe('2026-03-29T00:00:00.000Z');
    expect(zonedDayEnd('2026-03-29', 'Europe/London').getTime() - spring.getTime()).toBe(
      23 * 3_600_000,
    );
    const autumn = zonedDayStart('2026-10-25', 'Europe/London');
    expect(autumn.toISOString()).toBe('2026-10-24T23:00:00.000Z');
    expect(zonedDayEnd('2026-10-25', 'Europe/London').getTime() - autumn.getTime()).toBe(
      25 * 3_600_000,
    );
  });

  it('Cairo: a midnight the spring change skips starts the day at the first instant that exists', () => {
    // Egypt's clocks go from 00:00 to 01:00 on the last Friday of April: 00:00 never happens.
    for (const day of ['2026-04-24', '2026-10-29', '2026-10-30']) {
      const start = zonedDayStart(day, 'Africa/Cairo');
      expect(dayKeyIn(start, 'Africa/Cairo'), day).toBe(day);
      expect(dayKeyIn(start.getTime() - 1, 'Africa/Cairo'), day).toBe(addDays(day, -1));
    }
  });

  it('refuses a string that is not a day', () => {
    expect(() => zonedDayStart('15/10/2026', 'UTC')).toThrow(RangeError);
  });
});

describe('the small ones', () => {
  it('todayIn, addDays and zonedInstant', () => {
    const now = Date.parse('2026-12-31T21:30:00Z');
    expect(todayIn('Asia/Riyadh', now)).toBe('2027-01-01');
    expect(todayIn('UTC', now)).toBe('2026-12-31');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-10-15', 30)).toBe('2026-11-14');
    expect(zonedInstant('Asia/Riyadh', 2026, 10, 15, 14, 5).toISOString()).toBe(
      '2026-10-15T11:05:00.000Z',
    );
  });
});
