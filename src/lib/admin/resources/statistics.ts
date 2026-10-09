import { StatisticUpdateSchema, StatisticWriteSchema } from '@schemas/admin';
import type { ResourceConfig } from '../resource';
import { pick, refusePlaceholder, requireBilingual, statusOf, type Input } from './shared';

// Statistics: the figures the number bands count up to (0023).

export const statisticResource: ResourceConfig = {
  table: 'statistics',
  entity: 'statistic',
  writeCap: 'services.write',
  listColumns: 'id,slug,label,value,placements,is_placeholder,status,sort_order,version,updated_at',
  columns:
    'id,slug,label,value,value_numeric,value_suffix,placements,placement_labels,is_placeholder,' +
    'status,sort_order,version,created_at,updated_at',
  orderBy: { column: 'sort_order', ascending: true },
  searchColumn: 'slug',
  createSchema: StatisticWriteSchema,
  updateSchema: StatisticUpdateSchema,
  toRow: (input) => {
    const i = input as Input;
    const values = pick(i, {
      slug: 'slug',
      label: 'label',
      value: 'value',
      valueNumeric: 'value_numeric',
      valueSuffix: 'value_suffix',
      placements: 'placements',
      placementLabels: 'placement_labels',
      isPlaceholder: 'is_placeholder',
      status: 'status',
      sortOrder: 'sort_order',
    });
    // The 0023 statistics_value_consistent CHECK: with a number, the displayed value IS the
    // number plus its suffix (derived here); free text written without a number drops the
    // count-up number, or the stored one would contradict it.
    const numeric = i['valueNumeric'];
    if (typeof numeric === 'number') {
      values['value'] = `${Number(numeric.toFixed(2))}${String(i['valueSuffix'] ?? '')}`;
    } else if (i['value'] !== undefined && i['value'] !== null && numeric === undefined) {
      values['value_numeric'] = null;
      values['value_suffix'] = null;
    }
    return values;
  },
  statusOf: (input) => statusOf(input as Input),
  // The form edits per-page labels as a list; the column is an object keyed by page.
  fromRow: (row) => {
    const labels = row['placement_labels'];
    if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return row;
    return {
      ...row,
      placement_labels: Object.entries(labels as Record<string, unknown>).map(
        ([placement, label]) => ({ placement, label }),
      ),
    };
  },
  constraintFields: {
    statistics_value_consistent: {
      field: 'value',
      message: 'the value must read as the number plus its suffix',
    },
  },
  assertPublishable: (row) => {
    requireBilingual(row, 'label', 'Statistic label');
    refusePlaceholder(row, 'statistic');
  },
};
