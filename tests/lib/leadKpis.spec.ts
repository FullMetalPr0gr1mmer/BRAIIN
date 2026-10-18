import { describe, it, expect } from 'vitest';
import {
  LEAD_KPI_COUNTS,
  conversionOf,
  deltaOf,
  previousPeriod,
  readLeadKpis,
  readPerStage,
} from '@/lib/crm/leadKpis';

// The lead KPIs' arithmetic (Admin v2 C4a, crm.md §9): named figures only, conversion worked
// out in the Worker, deltas only against the previous period of equal length, and nothing
// invented when there is nothing to compare.

const STAGE = '33333333-3333-4333-8333-333333333333';

describe('readLeadKpis', () => {
  it('keeps the named figures, and drops anything else the database sent', () => {
    const kpis = readLeadKpis({
      total: 8,
      new: 3,
      won: 2,
      won_value: '75000',
      avg_first_response_hours: '2.5',
      web_response_hours: null,
      email: 'leak@example.test',
    });
    expect(kpis).toMatchObject({
      total: 8,
      new: 3,
      won: 2,
      won_value: 75000,
      avg_first_response_hours: 2.5,
      web_response_hours: null,
      conversion: 0.25,
    });
    expect(Object.keys(kpis).sort()).toEqual(
      [
        ...LEAD_KPI_COUNTS,
        'won_value',
        'avg_first_response_hours',
        'web_response_hours',
        'conversion',
      ].sort(),
    );
  });

  it('reads a missing or broken answer as zeros and no data', () => {
    const kpis = readLeadKpis(null);
    for (const key of LEAD_KPI_COUNTS) expect(kpis[key], key).toBe(0);
    expect(kpis.avg_first_response_hours).toBeNull();
    expect(kpis.conversion).toBeNull();
    expect(readLeadKpis({ total: -3, won: 'x' }).total).toBe(0);
  });
});

describe('readPerStage', () => {
  it('keeps stage ids with counts only', () => {
    expect(readPerStage({ per_stage: { [STAGE]: 4, nope: 2 } })).toEqual({ [STAGE]: 4 });
    expect(readPerStage({ per_stage: [1, 2] })).toEqual({});
    expect(readPerStage(undefined)).toEqual({});
  });
});

describe('conversion and deltas', () => {
  it('conversion is won over all leads, and null with no leads', () => {
    expect(conversionOf(1, 4)).toBe(0.25);
    expect(conversionOf(0, 0)).toBeNull();
  });

  it('a delta is the change over the previous figure; none from zero or from nothing', () => {
    expect(deltaOf(15, 10)).toBe(0.5);
    expect(deltaOf(5, 10)).toBe(-0.5);
    expect(deltaOf(3, 0)).toBeNull();
    expect(deltaOf(3, null)).toBeNull();
    expect(deltaOf(null, 3)).toBeNull();
  });

  it('the previous period ends where the range starts, and is as long', () => {
    expect(previousPeriod('2026-10-10T21:00:00.000Z', '2026-10-17T21:00:00.000Z')).toEqual({
      from: '2026-10-03T21:00:00.000Z',
      to: '2026-10-10T21:00:00.000Z',
    });
    // A range that runs to now (C4b): moved back by its whole days, so the earlier one ends
    // at the same time of day and is exactly as long.
    expect(previousPeriod('2026-10-10T21:00:00.000Z', '2026-10-17T12:00:00.000Z')).toEqual({
      from: '2026-10-03T21:00:00.000Z',
      to: '2026-10-10T12:00:00.000Z',
    });
    expect(previousPeriod('2026-10-17T21:00:00Z', '2026-10-10T21:00:00Z')).toBeNull();
    expect(previousPeriod('nope', '2026-10-10T21:00:00Z')).toBeNull();
  });
});
