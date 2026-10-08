import { SORT_FIELD, STATUS_FIELD } from './fields';
import type { ResourceUi } from './types';

// Certifications: the list and the form at /admin/certifications.
export const certificationsUi: ResourceUi = {
  slug: 'certifications',
  title: 'Certifications',
  singular: 'Certification',
  hasStatus: true,
  reorder: true,
  columns: [
    { key: 'name', label: 'Name', kind: 'bilingual' },
    { key: 'year', label: 'Year' },
    { key: 'status', label: 'Status', kind: 'status' },
  ],
  fields: [
    { name: 'slug', label: 'Slug', kind: 'slug', required: true },
    { name: 'name', label: 'Name', kind: 'bilingual', required: true },
    { name: 'issuer', label: 'Issuer', kind: 'prose' },
    { name: 'year', label: 'Year', kind: 'number' },
    { name: 'logoUrl', label: 'Logo URL', kind: 'url' },
    SORT_FIELD,
    STATUS_FIELD,
  ],
};
