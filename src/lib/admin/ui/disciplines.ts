import { SCHEDULED_FIELD, showreelClip, SORT_FIELD, STATUS_FIELD } from './fields';
import type { ResourceUi } from './types';

// Disciplines: the form in the Services overview's drawer (Admin v2 U5: /admin/services and a
// discipline's page, /admin/disciplines/[id], open it) and the no-JS form at
// /admin/disciplines/new. The labels are the prototype's ("Short line (on the card)",
// "Description (when the discipline is opened)", "Card video").
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
      label: 'Short line (on the card)',
      kind: 'bilingual',
      nullable: true,
      help: 'At most nine words, for example “The mark, the system, and everything it touches.”',
    },
    {
      name: 'blurb',
      label: 'Description (when the discipline is opened)',
      kind: 'bilingual',
      nullable: true,
      multiline: true,
      help: 'The paragraph at the top of its panel in the Services explorer.',
    },
    { name: 'posterMediaId', label: 'Poster', kind: 'media', help: 'The card image.' },
    showreelClip(
      'Card video',
      'The window of the showreel the card plays on hover. At most 30 seconds.',
    ),
    SORT_FIELD,
    {
      ...STATUS_FIELD,
      help: 'Published shows it on the site. Hiding or archiving a discipline hides every one of its services too. Only an Admin can archive.',
    },
    SCHEDULED_FIELD,
  ],
};
