import { UUID, type Case } from '../harness';

// The leads write API (Admin v2 C3). Working the pipeline is `leads.manage`; adding a lead
// by hand also writes a person's contact details, so it needs `leads.pii` too; erasing a
// lead and deleting a note are `crm.erase`, Admin only (CLAUDE.md §5). Content Creator and
// SEO get none of it.

export const cases: readonly Case[] = [
  {
    name: 'lead pipeline change (versioned PATCH)',
    load: () => import('@/pages/api/admin/leads/[id]'),
    method: 'PATCH',
    url: `/api/admin/leads/${UUID}`,
    body: { version: 1, stageId: UUID, assignedTo: null, tags: ['VIP'] },
    allow: ['admin', 'developer'],
  },
  {
    name: 'lead marks (star, read, log contact)',
    load: () => import('@/pages/api/admin/leads/[id]'),
    method: 'PATCH',
    url: `/api/admin/leads/${UUID}`,
    body: { isStarred: true, read: true, logContact: { channel: 'call' } },
    allow: ['admin', 'developer'],
  },
  {
    name: 'leads bulk change',
    load: () => import('@/pages/api/admin/leads/bulk'),
    method: 'POST',
    url: '/api/admin/leads/bulk',
    body: { action: 'stage', value: UUID, items: [{ id: UUID, version: 1 }] },
    allow: ['admin', 'developer'],
  },
  {
    name: 'lead added by hand (leads.manage + leads.pii)',
    load: () => import('@/pages/api/admin/leads/index'),
    method: 'POST',
    url: '/api/admin/leads',
    body: { name: 'Sara', phone: '0501234567', message: 'Called the office', channel: 'phone' },
    allow: ['admin', 'developer'],
  },
  {
    name: 'lead erase (crm.erase, Admin only)',
    load: () => import('@/pages/api/admin/leads/[id]/erase'),
    method: 'POST',
    url: `/api/admin/leads/${UUID}/erase`,
    body: { reason: 'dsar' },
    allow: ['admin'],
  },
  {
    name: 'lead note delete (crm.erase, Admin only)',
    load: () => import('@/pages/api/admin/leads/[id]/notes/[noteId]'),
    method: 'DELETE',
    url: `/api/admin/leads/${UUID}/notes/${UUID}`,
    allow: ['admin'],
  },
];
