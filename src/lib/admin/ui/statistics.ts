import { PLACEHOLDER_FIELD, SORT_FIELD, STATUS_FIELD } from './fields';
import type { ResourceUi } from './types';

// Statistics: the list and the form at /admin/statistics.
export const statisticsUi: ResourceUi = {
  slug: 'statistics',
  title: 'Statistics',
  singular: 'Statistic',
  hasStatus: true,
  reorder: true,
  columns: [
    { key: 'label', label: 'Label', kind: 'bilingual' },
    { key: 'value', label: 'Value' },
    { key: 'is_placeholder', label: 'Placeholder', kind: 'boolean' },
    { key: 'status', label: 'Status', kind: 'status' },
  ],
  fields: [
    { name: 'slug', label: 'Slug', kind: 'slug', required: true },
    { name: 'label', label: 'Label', kind: 'bilingual', required: true },
    {
      name: 'valueNumeric',
      label: 'Number',
      kind: 'number',
      help: 'The number the band counts up to. With a number, the displayed value is the number plus its suffix.',
    },
    {
      name: 'valueSuffix',
      label: 'Suffix',
      kind: 'text',
      help: '“+”, “%”, “x” — at most 4 characters.',
    },
    {
      name: 'value',
      label: 'Displayed value (no number)',
      kind: 'text',
      help: 'Only for a value that is not a plain number. With a number above, this is derived.',
    },
    {
      name: 'placements',
      label: 'Shown on',
      kind: 'multiSelect',
      options: [
        { value: 'home', label: 'Home' },
        { value: 'about', label: 'About' },
        { value: 'work', label: 'Our Work' },
        { value: 'services', label: 'Services page' },
      ],
    },
    {
      name: 'placementLabels',
      label: 'Label on a specific page',
      kind: 'repeater',
      maxItems: 4,
      help: 'Where a page words it differently (“Projects delivered across the region” on About).',
      itemFields: [
        {
          name: 'placement',
          label: 'Page',
          kind: 'select',
          required: true,
          options: [
            { value: 'home', label: 'Home' },
            { value: 'about', label: 'About' },
            { value: 'work', label: 'Our Work' },
            { value: 'services', label: 'Services page' },
          ],
        },
        { name: 'label', label: 'Label', kind: 'bilingual', required: true },
      ],
    },
    PLACEHOLDER_FIELD,
    SORT_FIELD,
    STATUS_FIELD,
  ],
};
