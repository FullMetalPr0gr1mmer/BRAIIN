import { SCHEDULED_FIELD, showreelClip, SORT_FIELD, STATUS_FIELD } from './fields';
import type { ResourceUi } from './types';

// Disciplines: the list and the form at /admin/disciplines.
export const disciplinesUi: ResourceUi = {
  slug: 'disciplines',
  title: 'Disciplines',
  singular: 'Discipline',
  hasStatus: true,
  reorder: true,
  columns: [
    { key: 'name', label: 'Name', kind: 'bilingual' },
    { key: 'slug', label: 'Slug' },
    { key: 'status', label: 'Status', kind: 'status' },
    { key: 'sort_order', label: 'Order' },
    { key: 'updated_at', label: 'Updated', kind: 'date' },
  ],
  fields: [
    {
      name: 'slug',
      label: 'Slug',
      kind: 'slug',
      required: true,
      help: 'Its anchor on the Services page: /services#<slug>. At most 64 characters.',
    },
    { name: 'name', label: 'Name', kind: 'bilingual', required: true },
    {
      name: 'short',
      label: 'Card line',
      kind: 'bilingual',
      nullable: true,
      help: 'One line on the discipline card, e.g. “The mark, the system, and everything it touches.”',
    },
    {
      name: 'blurb',
      label: 'Description',
      kind: 'bilingual',
      nullable: true,
      help: 'The paragraph at the top of its panel in the Services explorer.',
    },
    { name: 'posterMediaId', label: 'Poster', kind: 'media', help: 'The card image.' },
    showreelClip(
      'Card clip',
      'The window of the showreel the card plays on hover. At most 30 seconds.',
    ),
    SORT_FIELD,
    {
      ...STATUS_FIELD,
      help: 'Archiving a discipline hides every one of its services from the site. Archiving is Admin-only.',
    },
    SCHEDULED_FIELD,
  ],
};
