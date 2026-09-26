import { describe, it, expect } from 'vitest';
import { statisticResource } from '@/lib/admin/resources';
import { StatisticWriteSchema } from '@schemas/admin';

// 0023's statistics_value_consistent CHECK: when value_numeric is set, `value` must read
// exactly trim_scale(value_numeric) || coalesce(value_suffix, ''). Every admin save goes
// through toRow, so toRow is where that stays true — otherwise editing the live "14 crafts"
// stat to "15" would be refused by the database (the stored number would contradict it).

describe('statistics toRow keeps value and number in agreement', () => {
  it('derives the displayed value from a count-up number', () => {
    expect(statisticResource.toRow({ valueNumeric: 250, valueSuffix: '+' })).toMatchObject({
      value: '250+',
      value_numeric: 250,
    });
    expect(statisticResource.toRow({ valueNumeric: 1.5, valueSuffix: null })).toMatchObject({
      value: '1.5',
    });
  });

  it('free text written without a number drops the stored number and suffix', () => {
    expect(statisticResource.toRow({ value: '15' })).toEqual({
      value: '15',
      value_numeric: null,
      value_suffix: null,
    });
  });

  it('an explicit null number with free text leaves the text as written', () => {
    expect(statisticResource.toRow({ value: 'Top 10', valueNumeric: null })).toMatchObject({
      value: 'Top 10',
      value_numeric: null,
    });
  });

  it('numbers carry at most two decimals, as numeric(12,2) stores them', () => {
    const base = { slug: 'x', label: { en: 'X', ar: 'س' } };
    expect(StatisticWriteSchema.safeParse({ ...base, valueNumeric: 12.25 }).success).toBe(true);
    expect(StatisticWriteSchema.safeParse({ ...base, valueNumeric: 1.555 }).success).toBe(false);
  });
});
