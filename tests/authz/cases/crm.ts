import { UUID, type Case } from '../harness';

// The CRM's own configuration, as the lead screens read it (Admin v2 C2a): leads.manage,
// like the lead list. Changing it is CRM settings (Admin v2 C9a): crm.settings, Admin only
// (CLAUDE.md §5), the screen's read included.

export const cases: readonly Case[] = [
  {
    name: 'CRM stages',
    load: () => import('@/pages/api/admin/crm/stages'),
    method: 'GET',
    url: '/api/admin/crm/stages',
    allow: ['admin', 'developer', 'sales'],
  },
  {
    name: 'CRM people (assignees)',
    load: () => import('@/pages/api/admin/crm/people'),
    method: 'GET',
    url: '/api/admin/crm/people',
    allow: ['admin', 'developer', 'sales'],
  },
  {
    name: 'CRM settings read (crm.settings, Admin only)',
    load: () => import('@/pages/api/admin/crm/settings'),
    method: 'GET',
    url: '/api/admin/crm/settings',
    allow: ['admin'],
  },
  {
    name: 'CRM settings save (crm.settings, Admin only)',
    load: () => import('@/pages/api/admin/crm/settings'),
    method: 'PUT',
    url: '/api/admin/crm/settings',
    body: {
      version: 1,
      slaHours: 12,
      assignment: { rule: 'fixed', pool: [], fixedTo: UUID },
    },
    allow: ['admin'],
  },
  {
    name: 'CRM stages save (crm.settings, Admin only)',
    load: () => import('@/pages/api/admin/crm/stages'),
    method: 'PUT',
    url: '/api/admin/crm/stages',
    body: {
      known: [
        { id: UUID, version: 1 },
        { id: '22222222-2222-4222-8222-222222222222', version: 1 },
      ],
      stages: [
        { id: UUID, label: 'New', tone: 'klein', kind: 'open' },
        { label: 'Won', tone: 'ok', kind: 'won' },
        { label: 'Lost', tone: 'gray', kind: 'lost' },
      ],
    },
    allow: ['admin'],
  },
];
