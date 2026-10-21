import { PLACEHOLDER_FIELD, SORT_FIELD } from './fields';
import type { ResourceUi } from './types';

// Clients: the form in the collection screen's drawer at /admin/clients (Admin v2 U7b).
// `visible` IS the permission to name the client (CLAUDE.md §8), so its switch says so.
export const clientsUi: ResourceUi = {
  slug: 'clients',
  title: 'Clients',
  singular: 'Client',
  reorder: true,
  columns: [
    { key: 'name', label: 'Name', kind: 'bilingual' },
    { key: 'visible', label: 'Cleared (visible)', kind: 'boolean' },
    { key: 'show_in_marquee', label: 'Marquee', kind: 'boolean' },
    { key: 'is_placeholder', label: 'Placeholder', kind: 'boolean' },
  ],
  fields: [
    { name: 'slug', label: 'Slug', kind: 'slug', required: true },
    { name: 'name', label: 'Name', kind: 'bilingual', required: true },
    {
      name: 'visible',
      label: 'Visible on the site',
      kind: 'checkbox',
      help: 'Only switch this on when the client has agreed to be named. Until then the site shows “Confidential client”.',
    },
    {
      name: 'showInMarquee',
      label: 'Show in the clients marquee',
      help: 'The scrolling row of names. A client shows there only while it is visible.',
      kind: 'checkbox',
    },
    { name: 'logoMediaId', label: 'Logo', kind: 'media' },
    { name: 'websiteUrl', label: 'Website', kind: 'url', help: 'https only.' },
    PLACEHOLDER_FIELD,
    SORT_FIELD,
  ],
};
