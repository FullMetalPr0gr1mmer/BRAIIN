import type { Case } from '../harness';

// The CRM's own configuration, as the lead screens read it (Admin v2 C2a): leads.manage,
// like the lead list.

export const cases: readonly Case[] = [
  {
    name: 'CRM stages',
    load: () => import('@/pages/api/admin/crm/stages'),
    method: 'GET',
    url: '/api/admin/crm/stages',
    allow: ['admin', 'developer'],
  },
  {
    name: 'CRM people (assignees)',
    load: () => import('@/pages/api/admin/crm/people'),
    method: 'GET',
    url: '/api/admin/crm/people',
    allow: ['admin', 'developer'],
  },
];
