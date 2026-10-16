import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RANGE,
  STAT_RANGES,
  addDays,
  dayLabel,
  daysOf,
  hasPreviousPeriod,
  periodLabel,
  rangeFrom,
  rangeOfDays,
  rangeParam,
  statsHref,
} from '@/lib/admin/stats/range';

// The stats screens' ranges (Admin v2 U2, src/lib/admin/stats/range.ts): the last 7, 30 or
// 90 UTC days, today included, as the rollups count them; the previous period the same
// number of days just before; a change shown only when the rollups reach back over it.

// 2026-10-15 at 01:30 UTC: still the 15th in UTC, the 15th at 04:30 in Riyadh.
const NOW = Date.parse('2026-10-15T01:30:00Z');

describe('the range a URL names', () => {
  it('offers 7, 30 and 90 days, 30 by default', () => {
    expect([...STAT_RANGES]).toEqual([7, 30, 90]);
    expect(DEFAULT_RANGE).toBe(30);
    expect(rangeParam(null)).toBe(30);
    expect(rangeParam('7')).toBe(7);
    expect(rangeParam('90')).toBe(90);
    for (const bad of ['', '8', '0', '-7', '7.0x', '365', 'all']) expect(rangeParam(bad)).toBe(30);
  });

  it('ends today (UTC) and counts today as a day', () => {
    const range = rangeFrom(new URL('https://admin.test/admin/analytics?range=7'), NOW);
    expect(range).toEqual({
      days: 7,
      from: '2026-10-09',
      to: '2026-10-15',
      prevFrom: '2026-10-02',
      prevTo: '2026-10-08',
    });
    expect(daysOf(range)).toHaveLength(7);
  });

  it('uses UTC days: just before midnight UTC is still that day, even past midnight in Riyadh', () => {
    const late = Date.parse('2026-10-15T23:30:00Z'); // 02:30 on the 16th in Riyadh
    expect(rangeOfDays(1, late).to).toBe('2026-10-15');
  });

  it('crosses months and years', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    const range = rangeOfDays(30, Date.parse('2026-01-10T12:00:00Z'));
    expect(range.from).toBe('2025-12-12');
    expect(range.prevTo).toBe('2025-12-11');
    expect(range.prevFrom).toBe('2025-11-12');
  });

  it('the JSON routes may ask for any number of days', () => {
    const range = rangeOfDays(28, NOW);
    expect(daysOf(range)).toHaveLength(28);
    expect(range.from).toBe('2026-09-18');
  });
});

describe('a change against the previous period', () => {
  const range = rangeOfDays(7, NOW); // prevFrom 2026-10-02

  it('shows when the rollups start on or before the previous period', () => {
    expect(hasPreviousPeriod('2026-10-02', range)).toBe(true);
    expect(hasPreviousPeriod('2026-01-01', range)).toBe(true);
  });

  it('does not when counting started inside it, or has not started', () => {
    expect(hasPreviousPeriod('2026-10-03', range)).toBe(false);
    expect(hasPreviousPeriod('2026-10-12', range)).toBe(false);
    expect(hasPreviousPeriod(null, range)).toBe(false);
    expect(hasPreviousPeriod(undefined, range)).toBe(false);
    expect(hasPreviousPeriod('not a day', range)).toBe(false);
  });

  it('is said in words', () => {
    expect(periodLabel(range)).toBe('the previous 7 days');
  });
});

describe('links', () => {
  const url = new URL('https://admin.test/admin/analytics?tab=pages&range=7&page=3');

  it('keep the other parameters, drop the page, and drop the default range', () => {
    expect(statsHref('/admin/analytics', url, { range: '90' })).toBe(
      '/admin/analytics?tab=pages&range=90',
    );
    expect(statsHref('/admin/analytics', url, { range: '30' })).toBe('/admin/analytics?tab=pages');
    expect(statsHref('/admin/analytics', url, { tab: null })).toBe('/admin/analytics?range=7');
    expect(statsHref('/admin/analytics', url, { page: '2' })).toBe(
      '/admin/analytics?tab=pages&range=7&page=2',
    );
    expect(statsHref('/admin/analytics', new URL('https://admin.test/admin/analytics'), {})).toBe(
      '/admin/analytics',
    );
  });

  it('label days the way the rollup counts them (UTC)', () => {
    expect(dayLabel('2026-10-01')).toBe('1 Oct');
    expect(dayLabel('nonsense')).toBe('nonsense');
  });
});

describe('a share changes in points (U2 review)', () => {
  it('10% to 20% is up 10 points, said as points', async () => {
    const { deltaView, pointChange } = await import('@/lib/admin/kpi');
    expect(pointChange(20, 10)).toBe(10);
    expect(pointChange(20, null)).toBeNull();
    expect(pointChange(null, 10)).toBeNull();
    expect(deltaView(10, 'up', 'points')).toMatchObject({
      text: '10 points',
      spoken: 'up 10 points',
    });
    expect(deltaView(-1.2, 'up', 'points')).toMatchObject({
      text: '1 point',
      spoken: 'down 1 point',
    });
    expect(deltaView(0.2, 'up', 'points')?.spoken).toBe('no change');
    // The default is still a percent of the previous value.
    expect(deltaView(100)?.text).toBe('100%');
  });
});
