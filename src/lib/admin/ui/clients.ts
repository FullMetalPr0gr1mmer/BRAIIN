import { PLACEHOLDER_FIELD, SORT_FIELD } from './fields';
import type { ResourceUi } from './types';

// Clients: the list and the form at /admin/clients.
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
      label: 'Cleared for disclosure (visible)',
      kind: 'checkbox',
      help: 'Tick only once the client has agreed to be named. Until then the site shows “Confidential client”.',
    },
    {
      name: 'showInMarquee',
      label: 'Show in the clients marquee',
      kind: 'checkbox',
    },
    { name: 'logoMediaId', label: 'Logo', kind: 'media' },
    { name: 'websiteUrl', label: 'Website', kind: 'url', help: 'https only.' },
    PLACEHOLDER_FIELD,
    SORT_FIELD,
  ],
};
