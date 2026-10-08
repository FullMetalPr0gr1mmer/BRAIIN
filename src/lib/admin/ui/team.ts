import { PLACEHOLDER_FIELD, SORT_FIELD, STATUS_FIELD } from './fields';
import type { ResourceUi } from './types';

// Team & authors: the list and the form at /admin/team.
export const teamUi: ResourceUi = {
  slug: 'team',
  title: 'Team & authors',
  singular: 'Team member',
  hasStatus: true,
  reorder: true,
  columns: [
    { key: 'name', label: 'Name', kind: 'bilingual' },
    { key: 'role', label: 'Title', kind: 'bilingual' },
    { key: 'is_leadership', label: 'Leadership', kind: 'boolean' },
    { key: 'status', label: 'Status', kind: 'status' },
  ],
  fields: [
    { name: 'slug', label: 'Slug', kind: 'slug', required: true },
    { name: 'name', label: 'Name', kind: 'bilingual', required: true },
    { name: 'role', label: 'Job title', kind: 'bilingual', nullable: true },
    {
      name: 'isLeadership',
      label: 'Leadership',
      kind: 'checkbox',
      help: 'Shown in the About page leadership slider.',
    },
    { name: 'portraitMediaId', label: 'Portrait', kind: 'media' },
    {
      name: 'linkedinUrl',
      label: 'LinkedIn',
      kind: 'url',
      help: 'https://linkedin.com/in/… — the slider links it only when set.',
    },
    { name: 'bio', label: 'Bio', kind: 'prose' },
    { name: 'avatarUrl', label: 'Avatar URL', kind: 'url' },
    PLACEHOLDER_FIELD,
    SORT_FIELD,
    STATUS_FIELD,
  ],
};
