import { describe, expect, it } from 'vitest';
import {
  formatDate,
  formatDateTime,
  formatTime,
  isoOf,
  relTime,
  toDate,
} from '@/lib/admin/relTime';

// The admin's clock (Admin v2 F4b): Asia/Riyadh (UTC+3, no daylight saving), en-GB words.
// Every instant below is written in UTC, so the expectations show the +3 hours.

const NOW = '2026-10-12T09:00:00Z'; // 12:00 in Riyadh
const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();
const ahead = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('toDate', () => {
  it('reads a Date, an ISO string and epoch milliseconds, and refuses the rest', () => {
    expect(toDate(NOW)?.toISOString()).toBe('2026-10-12T09:00:00.000Z');
    expect(toDate(Date.parse(NOW))?.toISOString()).toBe('2026-10-12T09:00:00.000Z');
    expect(toDate(new Date(NOW))?.getTime()).toBe(Date.parse(NOW));
    for (const bad of ['', 'not a date', null, undefined, Number.NaN])
      expect(toDate(bad)).toBeNull();
  });

  it('copies a Date, so the caller’s object is never shared', () => {
    const d = new Date(NOW);
    expect(toDate(d)).not.toBe(d);
  });
});

describe('formatDate, formatTime, formatDateTime', () => {
  it('prints the Riyadh calendar date, the year only when it differs', () => {
    expect(formatDate('2026-10-12T09:00:00Z', { now: NOW })).toBe('12 Oct');
    expect(formatDate('2025-12-31T20:59:00Z', { now: NOW })).toBe('31 Dec 2025');
    // 21:00 UTC on 31 December is already 1 January in Riyadh.
    expect(formatDate('2025-12-31T21:00:00Z', { now: NOW })).toBe('1 Jan');
    expect(formatDate(NOW, { year: 'always', now: NOW })).toBe('12 Oct 2026');
  });

  it('spells September the same everywhere (no ICU month names)', () => {
    expect(formatDate('2026-09-05T09:00:00Z', { now: NOW })).toBe('5 Sep');
  });

  it('prints the 24-hour clock in Riyadh, midnight as 00', () => {
    expect(formatTime('2026-10-12T11:05:00Z')).toBe('14:05');
    expect(formatTime('2026-10-11T21:00:00Z')).toBe('00:00');
    expect(formatDateTime('2026-10-12T11:05:00Z')).toBe('12 Oct 2026, 14:05');
  });

  it('gives empty text for an invalid moment', () => {
    expect(formatDate('nope')).toBe('');
    expect(formatTime('nope')).toBe('');
    expect(formatDateTime('nope')).toBe('');
    expect(isoOf('nope')).toBe('');
    expect(isoOf(NOW)).toBe('2026-10-12T09:00:00.000Z');
  });
});

describe('relTime, in the past', () => {
  it.each([
    [0, 'just now'],
    [59 * 1000, 'just now'],
    [MIN, '1 min ago'],
    [59 * MIN, '59 min ago'],
    [HOUR, '1 h ago'],
    [23 * HOUR + 59 * MIN, '23 h ago'],
    [DAY, '1 d ago'],
    [6 * DAY, '6 d ago'],
    [7 * DAY, '5 Oct'],
    [300 * DAY, '16 Dec 2025'],
  ])('%i ms ago reads "%s"', (ms, text) => {
    expect(relTime(ago(ms), NOW)).toBe(text);
  });
});

describe('relTime, ahead of now', () => {
  it('reads a server clock a few seconds ahead as "just now"', () => {
    expect(relTime(ahead(30 * 1000), NOW)).toBe('just now');
  });

  it.each([
    [MIN, 'in 1 min'],
    [59 * MIN, 'in 59 min'],
    [3 * HOUR, 'in 3 h'], // 15:00 the same day
    [11 * HOUR + 59 * MIN, 'in 11 h'], // 23:59 the same day
    [12 * HOUR, 'tomorrow'], // 00:00 the next day
    [35 * HOUR, 'tomorrow'], // 23:00 the next day
    [36 * HOUR, 'in 2 d'],
    [6 * DAY, 'in 6 d'],
    [7 * DAY, '19 Oct'],
    [100 * DAY, '20 Jan 2027'],
  ])('%i ms ahead reads "%s"', (ms, text) => {
    expect(relTime(ahead(ms), NOW)).toBe(text);
  });
});

describe('relTime, inputs', () => {
  it('gives empty text for an invalid moment or reference', () => {
    expect(relTime('nope', NOW)).toBe('');
    expect(relTime(NOW, 'nope')).toBe('');
  });

  it('defaults to the current time', () => {
    expect(relTime(new Date())).toBe('just now');
  });
});
